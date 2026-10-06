# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = [
#   "mlx-audio>=0.5.7",
#   "mlx-whisper>=0.4.3",
#   "misaki[en]",
#   "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
#   "sounddevice",
#   "numpy",
# ]
# ///
import collections
import fcntl
import json
import os
import queue
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
import warnings
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import numpy as np
import sounddevice as sd

warnings.filterwarnings("ignore")

RATE = 16000
BLOCK = 0.1
WHISPERS = {
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "small": "mlx-community/whisper-small.en-mlx",
    "base": "mlx-community/whisper-base.en-mlx",
    "tiny": "mlx-community/whisper-tiny.en-mlx",
}
hearing = {"model": WHISPERS.get(os.environ.get("NO_HANDS_WHISPER", "turbo"), os.environ.get("NO_HANDS_WHISPER", ""))}
KOKORO = "mlx-community/Kokoro-82M-bf16"
USE_SAY = os.environ.get("NO_HANDS_TTS", "kokoro") == "say"
voice = {"name": os.environ.get("NO_HANDS_VOICE", "af_bella")}
SPEED = float(os.environ.get("NO_HANDS_SPEED", "1.0"))
PAUSE = float(os.environ.get("NO_HANDS_PAUSE", "3.0"))
level = {"speech": float(os.environ.get("NO_HANDS_LEVEL", "0.03"))}
level["barge"] = float(os.environ.get("NO_HANDS_BARGE", str(level["speech"] * 2)))
HEARTBEAT = 5
MAX_TURN = 120
PARTIAL_EVERY = 1.0
NO_SPEECH = 0.5
REPETITIVE = 2.4
SENT_SOUND = "/System/Library/Sounds/Pop.aiff"
MIN_SPEECH = 0.4
NOISE = {"thank you", "thanks", "thank you so much", "thanks for watching", "thank you for watching", "you", "bye", "okay", "uh", "um", "hmm"}

IDLE_LIMIT = 15 * 60
GRACE = 6.0
STALL = 2.0

jobs: queue.Queue = queue.Queue()
stops = [0]
speaking = threading.Lock()
barge = threading.Event()
playing = threading.Event()
user_talking = threading.Event()
muted = threading.Event()
mute = [""]
clients: dict = {}
floor: list = [None]
floor_lock = threading.RLock()
mic_thread: list = [None]
mic_stop = threading.Event()
listening = [0]
last_used = [time.monotonic()]
busy = [0]


def on_model_thread(fn, *args):
    done: Future = Future()
    jobs.put((fn, args, done))
    return done.result()


def model_thread(ready: threading.Event):
    import mlx_whisper
    from mlx_audio.tts.utils import load_model

    global tts, whisper
    try:
        whisper = mlx_whisper
        if not USE_SAY:
            tts = load_model(KOKORO)
            list(tts.generate(text="Ready.", voice=voice["name"], lang_code=voice["name"][0]))
        warm_whisper(hearing["model"])
    except Exception as e:
        print(f"failed: {e}", flush=True)
        os._exit(1)
    ready.set()
    while True:
        fn, args, done = jobs.get()
        try:
            done.set_result(fn(*args))
        except Exception as e:
            done.set_exception(e)


def warm_whisper(model: str):
    whisper.transcribe(np.zeros(RATE, dtype=np.float32), path_or_hf_repo=model, language="en")
    hearing["model"] = model


def transcribe(audio: np.ndarray) -> str:
    result = whisper.transcribe(
        audio, path_or_hf_repo=hearing["model"], language="en", condition_on_previous_text=False
    )
    spoken = [
        seg["text"]
        for seg in result["segments"]
        if seg["no_speech_prob"] < NO_SPEECH and seg["compression_ratio"] <= REPETITIVE
    ]
    text = "".join(spoken).strip()
    phrases = [p.strip().lower() for p in re.split(r"[.!?,]+", text) if p.strip()]
    return "" if all(p in NOISE for p in phrases) else text


def synthesize(text: str):
    name = voice["name"]
    segments = tts.generate(text=text, voice=name, speed=SPEED, lang_code=name[0])
    return [np.array(s.audio, dtype=np.float32) for s in segments]


def refresh_devices():
    sd.stop()
    try:
        sd._terminate()
        sd._initialize()
    except AttributeError:
        pass


def speak(text: str) -> str:
    asked = stops[0]
    deadline = time.monotonic() + 60
    while user_talking.is_set() and stops[0] == asked and time.monotonic() < deadline:
        time.sleep(0.05)
    with speaking:
        barge.clear()
        if USE_SAY:
            return speak_with_say(" ".join(text.split()), asked)
        clips = on_model_thread(synthesize, " ".join(text.split()))
        if user_talking.is_set() or stops[0] != asked:
            return "interrupted"
        playing.set()
        try:
            for clip in clips:
                try:
                    sd.play(clip, tts.sample_rate)
                except sd.PortAudioError:
                    if not listening[0]:
                        refresh_devices()
                    sd.play(clip, tts.sample_rate)
                end = time.monotonic() + len(clip) / tts.sample_rate + 1
                while sd.get_stream().active:
                    if stops[0] != asked or barge.is_set():
                        sd.stop()
                        return "interrupted"
                    if time.monotonic() > end:
                        sd.stop()
                        break
                    time.sleep(0.03)
        finally:
            playing.clear()
    return "done"


def speak_with_say(text: str, asked: int) -> str:
    if user_talking.is_set() or stops[0] != asked:
        return "interrupted"
    playing.set()
    say = subprocess.Popen(["say", "-r", str(round(185 * SPEED)), text])
    try:
        while say.poll() is None:
            if stops[0] != asked or barge.is_set():
                say.terminate()
                return "interrupted"
            time.sleep(0.03)
    finally:
        playing.clear()
    return "done"


def listen(send):
    user_talking.clear()
    blocks: queue.Queue = queue.Queue()
    size = int(RATE * BLOCK)
    last_block = [time.monotonic()]

    def on_audio(data, frames, when, status):
        blocks.put(data[:, 0].copy())

    def utterance():
        before = collections.deque(maxlen=3)
        heard: list[np.ndarray] = []
        quiet = 0.0
        last_beat = last_partial = time.monotonic()
        loud_time = 0.0
        partial: list[Future | None] = [None]
        is_finishing = threading.Event()

        def start_partial(audio):
            done: Future = Future()
            partial[0] = done

            def run():
                try:
                    text = on_model_thread(transcribe, audio)
                    if not is_finishing.is_set():
                        send({"partial": text})
                finally:
                    done.set_result(None)

            threading.Thread(target=run, daemon=True).start()

        while True:
            if mic_stop.is_set():
                is_finishing.set()
                if partial[0] is not None:
                    partial[0].result()
                return False
            try:
                block = blocks.get(timeout=0.5)
            except queue.Empty:
                block = None
            now = time.monotonic()
            if now - last_beat >= HEARTBEAT:
                last_beat = now
                send({"beat": True})
            if block is None:
                if now - last_block[0] >= STALL:
                    raise RuntimeError("the microphone stopped sending audio (was it unplugged?)")
                continue
            last_block[0] = now
            peak = float(np.abs(block).max())
            is_loud = peak > (level["barge"] if playing.is_set() else level["speech"])
            if not heard:
                before.append(block)
                if is_loud:
                    heard.extend(before)
                    if not muted.is_set():
                        user_talking.set()
                        barge.set()
                        send({"start": True})
                continue
            heard.append(block)
            if peak > level["speech"]:
                quiet = 0.0
                loud_time += BLOCK
            else:
                quiet += BLOCK
            if quiet >= PAUSE or len(heard) * BLOCK >= MAX_TURN:
                break
            busy = partial[0] is not None and not partial[0].done()
            if now - last_partial >= PARTIAL_EVERY and not busy and not muted.is_set():
                last_partial = now
                start_partial(np.concatenate(heard))

        is_finishing.set()
        if partial[0] is not None:
            partial[0].result()
        text = on_model_thread(transcribe, np.concatenate(heard)) if loud_time >= MIN_SPEECH else ""
        if text and not muted.is_set():
            subprocess.Popen(["afplay", SENT_SOUND])
        send({"final": text})
        user_talking.clear()
        return True

    if not listening[0] and not playing.is_set():
        refresh_devices()
    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=size, callback=on_audio):
        listening[0] += 1
        try:
            for c in list(clients.values()):
                c.post({"ready": True})
            last_block[0] = time.monotonic()
            while utterance():
                pass
        finally:
            listening[0] -= 1
            user_talking.clear()


class Client:
    def __init__(self, sid: str, label: str, send):
        self.sid, self.label, self.send = sid, label, send
        self.state, self.text, self.last, self.rank = "idle", "", "", 0
        self.since = self.spoke_at = 0.0
        self.skipped = False
        self.gone = threading.Event()

    def post(self, msg):
        try:
            self.send(msg)
        except ConnectionError:
            self.gone.set()


def roster():
    return [{"label": c.label, "state": c.state, "rank": c.rank, "floor": c.sid == floor[0]} for c in clients.values()]


def broadcast():
    with floor_lock:
        holder = clients.get(floor[0])
        msg = {"sessions": roster(), "holder": holder.label if holder else "", "mute": mute[0]}
        targets = list(clients.values())
    for c in targets:
        c.post({**msg, "floor": c.sid == floor[0]})


def to_floor(msg):
    with floor_lock:
        c = clients.get(floor[0])
    if c is not None:
        c.post(msg)


def spoken_as(c, text: str) -> str:
    return f"{c.label}: {text}" if c is not None and len(clients) > 1 else text


def next_waiting(exclude=None):
    found = [c for c in clients.values() if c.state == "waiting" and c.sid != exclude]
    return min(found, key=lambda c: (c.skipped, -c.rank, c.since), default=None)


def is_free(c) -> bool:
    if c is None or c.state == "working":
        return True
    return c.state == "idle" and time.monotonic() - c.spoke_at >= GRACE and not user_talking.is_set()


def requeue(c):
    if c is not None and c.state == "asking" and c.last:
        c.state, c.text, c.since, c.skipped = "waiting", c.last, time.monotonic(), True


def settle(c):
    c.state = "asking" if c.rank >= 3 else "idle"
    c.spoke_at = time.monotonic()
    c.skipped = False
    if c.state == "idle":
        threading.Timer(GRACE + 0.1, advance).start()


def play(c, text: str):
    speak(spoken_as(c, text))
    with floor_lock:
        if c.text == text:
            c.text = ""
            settle(c)
    broadcast()


def give(c):
    floor[0] = c.sid
    if c.text:
        threading.Thread(target=play, args=(c, c.text), daemon=True).start()
    threading.Thread(target=broadcast, daemon=True).start()


def advance():
    with floor_lock:
        nxt = next_waiting(exclude=floor[0])
        if nxt is not None and is_free(clients.get(floor[0])):
            give(nxt)


def run_mic():
    try:
        listen(to_floor)
    except Exception as e:
        for c in list(clients.values()):
            c.post({"error": str(e)})
            c.gone.set()
    finally:
        mic_thread[0] = None


def join(sid: str, label: str, send):
    with floor_lock:
        old = clients.pop(sid, None)
        if old is not None:
            old.gone.set()
        taken = {c.label for c in clients.values()}
        name, n = label, 2
        while name in taken:
            name, n = f"{label} {n}", n + 1
        c = Client(sid, name, send)
        clients[sid] = c
        if floor[0] not in clients:
            floor[0] = sid
    if not mute[0] and not start_mic() and listening[0]:
        c.post({"ready": True})
    broadcast()
    return c


def start_mic() -> bool:
    running = mic_thread[0]
    if running is not None and mic_stop.is_set():
        running.join(timeout=3)
        running = mic_thread[0]
    if running is not None or not clients:
        return False
    mic_stop.clear()
    mic_thread[0] = threading.Thread(target=run_mic, daemon=True)
    mic_thread[0].start()
    return True


def leave(c):
    with floor_lock:
        if clients.get(c.sid) is c:
            del clients[c.sid]
        c.gone.set()
        if floor[0] not in clients:
            nxt = next_waiting() or next(iter(clients.values()), None)
            floor[0] = None
            if nxt is not None:
                give(nxt)
        if not clients:
            mic_stop.set()
            threading.Timer(3, lambda: clients or os._exit(0)).start()
    broadcast()


def say_for(sid: str, kind: str, rank: int, text: str) -> str:
    with floor_lock:
        c = clients.get(sid)
        is_queued = c is not None and len(clients) > 1 and floor[0] != sid
        if is_queued and kind != "result":
            return "skipped"
        if is_queued:
            c.text, c.last, c.rank, c.since, c.skipped, c.state = text, text, rank, time.monotonic(), False, "waiting"
    if is_queued:
        broadcast()
        advance()
        return "queued"
    said = speak(spoken_as(c, text) if kind == "result" else text)
    if c is not None and kind == "result":
        with floor_lock:
            c.last, c.rank = text, rank
            settle(c)
        broadcast()
    return said


def words_of(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", text.lower()).split())


def switch_to(name: str) -> str:
    want = words_of(name)
    with floor_lock:
        found = [c for c in clients.values() if words_of(c.label) == want] or [c for c in clients.values() if want and (want in words_of(c.label) or words_of(c.label) in want)]
        if not found:
            return "none"
        c = found[0]
        if floor[0] != c.sid:
            requeue(clients.get(floor[0]))
            give(c)
        has_text = bool(c.text)
    if not has_text:
        speak(f"Now on {c.label}.")
    return f"ok {c.label}"


def pass_floor() -> str:
    with floor_lock:
        nxt = next_waiting(exclude=floor[0])
        if nxt is None:
            return "none"
        requeue(clients.get(floor[0]))
        give(nxt)
    return f"ok {nxt.label}"


def quit_when_idle():
    while True:
        time.sleep(30)
        if busy[0] == 0 and time.monotonic() - last_used[0] > IDLE_LIMIT:
            os._exit(0)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def handle_one_request(self):
        busy[0] += 1
        try:
            super().handle_one_request()
        finally:
            busy[0] -= 1
            last_used[0] = time.monotonic()

    def log_message(self, *args):
        pass

    def reply(self, text: str):
        body = text.encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == "/sessions":
            with floor_lock:
                return self.reply(json.dumps(roster()))
        if url.path != "/listen":
            return self.reply("ok listening" if listening[0] or clients else "ok idle")
        query = parse_qs(url.query)
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        lock = threading.Lock()

        def send(msg):
            with lock:
                try:
                    self.wfile.write((json.dumps(msg) + "\n").encode())
                    self.wfile.flush()
                except OSError as e:
                    raise ConnectionError from e

        c = join(query.get("session", ["solo"])[0], query.get("label", ["Claude"])[0], send)
        try:
            while not c.gone.wait(HEARTBEAT):
                c.post({"beat": True})
        finally:
            leave(c)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode()
        url = urlparse(self.path)
        query = parse_qs(url.query)
        sid = query.get("session", [""])[0]
        if url.path == "/speak":
            rank = int(query.get("rank", ["0"])[0] or 0)
            return self.reply(say_for(sid, query.get("kind", ["update"])[0], rank, body))
        if url.path == "/state":
            with floor_lock:
                c = clients.get(sid)
                if c is not None and body.strip() == "working":
                    c.state, c.text = "working", ""
                elif c is not None and body.strip() == "idle" and c.state == "working":
                    c.state, c.spoke_at = "idle", time.monotonic()
                    threading.Timer(GRACE + 0.1, advance).start()
            broadcast()
            advance()
            return self.reply("ok")
        if url.path == "/next":
            return self.reply(pass_floor())
        if url.path == "/floor":
            return self.reply(switch_to(body))
        if url.path == "/leave":
            with floor_lock:
                c = clients.get(sid)
            if c is not None:
                c.gone.set()
            return self.reply("ok")
        if url.path == "/voice":
            name = body.strip()
            if not name:
                return self.reply("failed: no voice name")
            if not USE_SAY:
                try:
                    on_model_thread(lambda: list(tts.generate(text="Hi.", voice=name, lang_code=name[0])))
                except Exception as e:
                    return self.reply(f"failed: {e}")
            voice["name"] = name
            return self.reply("ok")
        if url.path == "/model":
            model = WHISPERS.get(body.strip(), body.strip())
            try:
                on_model_thread(warm_whisper, model)
            except Exception as e:
                return self.reply(f"failed: {e}")
            return self.reply("ok")
        if url.path == "/level":
            try:
                value = float(body)
            except ValueError:
                return self.reply(f"failed: {body.strip()!r} is not a number")
            if not 0 < value < 1:
                return self.reply(f"failed: {value} is not between 0 and 1")
            level["speech"] = value
            level["barge"] = level["speech"] * 2
            return self.reply("ok")
        if url.path == "/mute":
            mute[0] = body.strip() if body.strip() in ("muted", "deafened") else ""
            if mute[0]:
                muted.set()
                mic_stop.set()
                stops[0] += 1 if mute[0] == "deafened" else 0
            else:
                muted.clear()
                start_mic()
            broadcast()
            return self.reply("ok")
        if url.path == "/stop":
            stops[0] += 1
            return self.reply("ok")
        if url.path == "/quit":
            self.reply("ok")
            os._exit(0)
        self.send_error(404)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        conn, _ = self.socket.accept()
        return conn, ("voice", 0)


def reachable(path: str) -> bool:
    probe = socket.socket(socket.AF_UNIX)
    try:
        probe.connect(path)
        return True
    except OSError:
        return False
    finally:
        probe.close()


def main():
    path = sys.argv[1]
    lock = open(f"{path}.lock", "w")
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if reachable(path):
                print("busy", flush=True)
                sys.exit(3)
            time.sleep(0.5)
    if os.path.exists(path):
        if reachable(path):
            print("busy", flush=True)
            sys.exit(3)
        os.unlink(path)
    ready = threading.Event()
    threading.Thread(target=model_thread, args=(ready,), daemon=True).start()
    ready.wait()
    server = Server(path, Handler)
    threading.Thread(target=quit_when_idle, daemon=True).start()
    print("ready", flush=True)
    try:
        server.serve_forever()
    finally:
        os.unlink(path)


if __name__ == "__main__":
    main()
