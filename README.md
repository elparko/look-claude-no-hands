# Look Claude, no hands

Hands-free voice mode for Claude Code on macOS.

Type `/talk` once. After that you talk to Claude and it talks back. When a request needs work, Claude first says what it understood and what it is about to do. When the turn ends, it says what it did and what it found, then listens for your answer. You don't press anything.

## Install

Requirements:

- A Mac with Apple Silicon (M1 or later). Speech-to-text and text-to-speech both use MLX, Apple's machine-learning framework, which needs it.
- Claude Code
- `uv`, the Python tool installer

1. Install the mod:

   ```
   claude plugin marketplace add elparko/look-claude-no-hands
   claude plugin install no-hands@no-hands
   ```

2. Restart Claude Code, or run `/reload-plugins`.

3. Type `/talk`. macOS asks to give your terminal app microphone access the first time. Allow it.

The first `/talk` takes a few minutes: `uv` installs the Python packages, and the Whisper speech model (about 1.5 GB) and the Kokoro voice model (about 340 MB) download once. After that, starting takes about 8 seconds.

## Use

| Action | How |
|---|---|
| Start | Type `/talk` |
| Send what you said | Pause for 3 seconds, or end with "go ahead" |
| Discard what you just said | Say "never mind" |
| Answer by typing instead | Type a prompt. Speech or recording stops, and the next reply is still spoken. |
| Pause | Press Esc during a turn. Type `/talk` to resume. |
| Stop | Type `/talk` again |

Voice mode also turns off after 3 minutes with no speech.

An animated indicator above the prompt shows what it is doing: a green wave while listening, with your words appearing as you say them; a cyan wave while speaking; and a spinner while Claude is working.

## How it works

`voiced.py` is a small local server that keeps both speech models loaded. `/talk` starts it through the `voiced` launcher, and the mod talks to it over a Unix socket. It quits when voice mode turns off, or after 15 minutes with no requests.

1. **Listen.** The server plays a tone and records from the default microphone. Recording starts when sound goes above 3% volume and ends after 3 seconds below it, or as soon as you say "go ahead". About once a second, Whisper large-v3-turbo transcribes what you have said so far, and the indicator shows it.
2. **Submit.** The final transcript is submitted as your prompt. Transcripts with no words in them, which Whisper produces from background noise, are ignored.
3. **First reply.** While voice mode is on, the mod adds one paragraph to the system prompt asking Claude to start with one plain sentence saying what it understood and what it will do. The mod speaks that sentence as soon as Claude makes its first tool call.
4. **Last reply.** When the turn ends, the mod sends a copy of the conversation, with the same model, one extra request: say what you did and what you found in 1 to 3 spoken sentences, and end with any question for me. Most of that request is served from the prompt cache. The reply on screen is unchanged.
5. **Speak.** Kokoro, an 82-million-parameter text-to-speech model, turns each sentence into audio and plays it. The first sentence starts in under a second. If the server cannot speak, the macOS `say` voice reads it instead.

No audio leaves the machine.

## Settings

Set these in your shell profile, then restart Claude Code:

| Variable | Default | Meaning |
|---|---|---|
| `NO_HANDS_VOICE` | `af_heart` | Kokoro voice. The first letter sets the accent: `a` American, `b` British. The second sets female or male. Examples: `af_bella`, `am_michael`, `bf_emma`, `bm_george`. |
| `NO_HANDS_SPEED` | `1.0` | Speaking rate. `1.2` is 20% faster. |
| `NO_HANDS_PAUSE` | `3.0` | Seconds of silence that send what you said. |
| `NO_HANDS_LEVEL` | `0.03` | Volume, from 0 to 1, that counts as speech. Raise it in a loud room. |

The full voice list is on the [Kokoro model page](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).

## Files

```
hooks/register.tsx       the mod: /talk command, the listen and speak loop, the indicator band
hooks/indicator.tsx      the animated indicator above the prompt
voiced                   starts the server if it is not running, and waits until it is ready
voiced.py                the server: Whisper, Kokoro, microphone and speaker
tests/register.test.ts   behavior tests
```

Run the tests:

```
claude plugin test .
```

The server log is at `$TMPDIR/no-hands-voiced.log`.

## Known limits

- English only. To change it, edit `language="en"` in `voiced.py`.
- With speakers instead of headphones, keep the volume moderate. Recording starts only after speaking ends, so the Mac's own voice is not recorded.
- Claude Code mods are an early-access feature, and the API may change between Claude Code releases.

## License

MIT
