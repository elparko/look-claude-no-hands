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

import numpy as np
import sounddevice as sd

warnings.filterwarnings("ignore")

RATE = 16000
BLOCK = 0.1
WHISPER = "mlx-community/whisper-large-v3-turbo"
KOKORO = "mlx-community/Kokoro-82M-bf16"
voice = {"name": os.environ.get("NO_HANDS_VOICE", "af_heart")}
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

jobs: queue.Queue = queue.Queue()
stop = threading.Event()
barge = threading.Event()
playing = threading.Event()
user_talking = threading.Event()
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
        tts = load_model(KOKORO)
        whisper = mlx_whisper
        list(tts.generate(text="Ready.", voice=voice["name"], lang_code=voice["name"][0]))
        whisper.transcribe(np.zeros(RATE, dtype=np.float32), path_or_hf_repo=WHISPER, language="en")
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


def transcribe(audio: np.ndarray) -> str:
    result = whisper.transcribe(
        audio, path_or_hf_repo=WHISPER, language="en", condition_on_previous_text=False
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


def speak(text: str) -> str:
    deadline = time.monotonic() + 60
    while user_talking.is_set() and time.monotonic() < deadline:
        time.sleep(0.05)
    stop.clear()
    barge.clear()
    clips = on_model_thread(synthesize, " ".join(text.split()))
    if user_talking.is_set() or stop.is_set():
        return "interrupted"
    playing.set()
    try:
        for clip in clips:
            sd.play(clip, tts.sample_rate)
            while sd.get_stream().active:
                if stop.is_set() or barge.is_set():
                    sd.stop()
                    return "interrupted"
                time.sleep(0.03)
    finally:
        playing.clear()
    return "done"


def listen(send):
    blocks: queue.Queue = queue.Queue()
    size = int(RATE * BLOCK)

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
            try:
                block = blocks.get(timeout=0.5)
            except queue.Empty:
                block = None
            now = time.monotonic()
            if now - last_beat >= HEARTBEAT:
                last_beat = now
                send({"beat": True})
            if block is None:
                continue
            peak = float(np.abs(block).max())
            is_loud = peak > (level["barge"] if playing.is_set() else level["speech"])
            if not heard:
                before.append(block)
                if is_loud:
                    heard.extend(before)
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
            if now - last_partial >= PARTIAL_EVERY and not busy:
                last_partial = now
                start_partial(np.concatenate(heard))

        is_finishing.set()
        if partial[0] is not None:
            partial[0].result()
        text = on_model_thread(transcribe, np.concatenate(heard)) if loud_time >= MIN_SPEECH else ""
        if text:
            subprocess.Popen(["afplay", SENT_SOUND])
        send({"final": text})
        user_talking.clear()

    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=size, callback=on_audio):
        send({"ready": True})
        try:
            while True:
                utterance()
        except ConnectionError:
            user_talking.clear()


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
        if self.path != "/listen":
            return self.reply("ok")
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

        try:
            listen(send)
        except Exception as e:
            try:
                send({"error": str(e)})
            except ConnectionError:
                pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode()
        if self.path == "/speak":
            return self.reply(speak(body))
        if self.path == "/voice":
            voice["name"] = body.strip()
            return self.reply("ok")
        if self.path == "/level":
            level["speech"] = float(body)
            level["barge"] = level["speech"] * 2
            return self.reply("ok")
        if self.path == "/stop":
            stop.set()
            return self.reply("ok")
        if self.path == "/quit":
            self.reply("ok")
            os._exit(0)
        self.send_error(404)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        conn, _ = self.socket.accept()
        return conn, ("voice", 0)


def main():
    path = sys.argv[1]
    if os.path.exists(path):
        try:
            probe = socket.socket(socket.AF_UNIX)
            probe.connect(path)
            probe.close()
            print("busy", flush=True)
            sys.exit(3)
        except OSError:
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
