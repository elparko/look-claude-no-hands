# Look Claude, no hands

Hands-free voice mode for Claude Code on macOS.

Type `/talk` once. After that, Claude speaks each reply out loud, then listens for your answer and submits it. You don't press anything.

## Install

Requirements:

- A Mac with Apple Silicon (M1 or later). Speech-to-text and text-to-speech both use MLX, Apple's machine-learning framework, which needs it.
- Claude Code
- Homebrew
- `uv`, the Python tool installer

1. Install the audio tools:

   ```
   brew install sox espeak-ng
   uv tool install mlx-whisper
   uv tool install --python 3.12 mlx-audio --with 'misaki[en]' \
     --with 'en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl'
   ```

   `mlx-audio` runs the Kokoro voice. `misaki` and the spaCy English model turn text into phonemes for it. Without `mlx-audio`, the mod uses the macOS `say` voice instead.

2. Install the mod:

   ```
   claude plugin marketplace add elparko/look-claude-no-hands
   claude plugin install no-hands@no-hands
   ```

3. Restart Claude Code, or run `/reload-plugins`.

4. Type `/talk`. macOS asks to give your terminal app microphone access the first time. Allow it.

On first use, the Whisper speech model (about 1.5 GB) and the Kokoro voice model (about 340 MB) download once.

## Use

| Action | How |
|---|---|
| Start | Type `/talk` |
| Stop | Say "stop listening", or type `/talk` again |
| Discard what you just said | Say "never mind" |
| Answer by typing instead | Type a prompt. Speech or recording stops, and the next reply is still spoken. |
| Pause | Press Esc during a turn. Type `/talk` to resume. |

Voice mode also turns off after 3 minutes with no speech.

An animated indicator above the prompt shows what it is doing: a moving green wave while listening, a cyan wave while speaking, and a spinner while Claude is working or preparing the spoken reply.

## How it works

1. **Turn ends.** The mod sends a copy of the current conversation, with the same model, one extra request: rewrite the last reply as 1 to 4 spoken sentences, with no code, file paths, URLs or lists, and keep any question asked. Most of that request is served from the prompt cache. The reply on screen is unchanged.
2. **Speak.** `speak.sh` turns that text into audio with Kokoro, an 82-million-parameter text-to-speech model, on your Mac, then plays it. Generating takes about 4 seconds, mostly model loading. If Kokoro is missing or fails, the macOS `say` voice reads it instead. If the rewrite fails, it reads the first paragraph of the reply with code removed.
3. **Record.** `listen.sh` plays a tone, then `rec` (from sox) records until 2 seconds of silence, up to 2 minutes.
4. **Transcribe.** `mlx_whisper` runs Whisper large-v3-turbo on your Mac. No audio leaves the machine. It takes about 2 seconds once the model is loaded.
5. **Submit.** The text is submitted as your prompt, and the cycle repeats.

Recording starts only after speaking ends, so the mic does not pick up the Mac's voice.

## Voice

Set these in your shell profile, then restart Claude Code:

| Variable | Default | Meaning |
|---|---|---|
| `NO_HANDS_VOICE` | `af_heart` | Kokoro voice. The first letter sets the accent: `a` American, `b` British. The second sets female or male. Examples: `af_bella`, `am_michael`, `bf_emma`, `bm_george`. |
| `NO_HANDS_SPEED` | `1.0` | Speaking rate. `1.2` is 20% faster. |

The full voice list is on the [Kokoro model page](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).

Try a voice:

```
NO_HANDS_VOICE=bm_george ./speak.sh "Testing the British voice."
```

## Files

```
hooks/register.tsx       the mod: /talk command, turn-end handling, the listen loop
hooks/indicator.tsx      the animated indicator above the prompt
listen.sh                plays the tone, records, transcribes, prints the text
speak.sh                 turns text into audio with Kokoro and plays it
tests/register.test.ts   behavior tests
```

Run the tests:

```
claude plugin test .
```

Test the transcription step without a microphone:

```
say -o /tmp/s.aiff "testing one two" && sox /tmp/s.aiff -r 16000 -c 1 /tmp/s.wav
./listen.sh --file /tmp/s.wav
```

## Known limits

- English only. To change it, edit `--language en` in `listen.sh`.
- A loud room can start a recording before you speak, because sox starts on any sound above 3% volume. Raise the two `3%` values in `listen.sh` to make it less sensitive.
- Cancelling speech or a recording runs `pkill -f claude-voice-talk`, which matches the speech, playback, recording and transcription processes by their temporary folder name.
- Claude Code mods are an early-access feature, and the API may change between Claude Code releases.

## License

MIT
