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
VOICE = os.environ.get("NO_HANDS_VOICE", "af_heart")
SPEED = float(os.environ.get("NO_HANDS_SPEED", "1.0"))
PAUSE = float(os.environ.get("NO_HANDS_PAUSE", "3.0"))
LEVEL = float(os.environ.get("NO_HANDS_LEVEL", "0.03"))
WAIT_LIMIT = 180
MAX_TURN = 120
PARTIAL_EVERY = 1.0
TONE = "/System/Library/Sounds/Tink.aiff"
GO_AHEAD = re.compile(r"[\s,.]*\bgo ahead\W*$", re.I)

IDLE_LIMIT = 15 * 60

jobs: queue.Queue = queue.Queue()
stop = threading.Event()
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
        list(tts.generate(text="Ready.", voice=VOICE, lang_code=VOICE[0]))
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
    return result["text"].strip()


def synthesize(text: str):
    segments = tts.generate(text=text, voice=VOICE, speed=SPEED, lang_code=VOICE[0])
    return [np.array(s.audio, dtype=np.float32) for s in segments]


def speak(text: str) -> str:
    stop.clear()
    for clip in on_model_thread(synthesize, " ".join(text.split())):
        if stop.is_set():
            break
        sd.play(clip, tts.sample_rate)
        while sd.get_stream().active:
            if stop.is_set():
                sd.stop()
                break
            time.sleep(0.03)
    return "stopped" if stop.is_set() else "done"


def listen(send):
    stop.clear()
    subprocess.run(["afplay", TONE])
    blocks: queue.Queue = queue.Queue()
    size = int(RATE * BLOCK)

    def on_audio(data, frames, when, status):
        blocks.put(data[:, 0].copy())

    before = collections.deque(maxlen=3)
    heard: list[np.ndarray] = []
    waited = quiet = 0.0
    partial: list[Future | None] = [None]
    last_partial = 0.0
    is_finishing = threading.Event()
    is_go_ahead = threading.Event()

    def start_partial(audio):
        done: Future = Future()
        partial[0] = done

        def run():
            try:
                text = on_model_thread(transcribe, audio)
                if GO_AHEAD.search(text):
                    is_go_ahead.set()
                if not stop.is_set() and not is_finishing.is_set():
                    send({"partial": GO_AHEAD.sub("", text)})
            finally:
                done.set_result(None)

        threading.Thread(target=run, daemon=True).start()

    with sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=size, callback=on_audio):
        while True:
            if stop.is_set():
                return send({"stopped": True})
            try:
                block = blocks.get(timeout=0.5)
            except queue.Empty:
                continue
            is_loud = float(np.abs(block).max()) > LEVEL
            if not heard:
                before.append(block)
                waited += BLOCK
                if is_loud:
                    heard.extend(before)
                elif waited > WAIT_LIMIT:
                    return send({"timeout": True})
                continue
            heard.append(block)
            quiet = 0.0 if is_loud else quiet + BLOCK
            if quiet >= PAUSE or is_go_ahead.is_set() or len(heard) * BLOCK >= MAX_TURN:
                break
            now = time.monotonic()
            busy = partial[0] is not None and not partial[0].done()
            if now - last_partial >= PARTIAL_EVERY and not busy:
                last_partial = now
                start_partial(np.concatenate(heard))

    is_finishing.set()
    send({"transcribing": True})
    if partial[0] is not None:
        partial[0].result()
    send({"final": GO_AHEAD.sub("", on_model_thread(transcribe, np.concatenate(heard)))})


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
                except OSError:
                    stop.set()

        try:
            listen(send)
        except Exception as e:
            send({"error": str(e)})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode()
        if self.path == "/speak":
            return self.reply(speak(body))
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
