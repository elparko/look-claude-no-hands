# Look Claude, no hands

Hands-free voice mode for Claude Code on macOS.

Type `/talk` once. After that you just talk. Claude answers out loud, and the words it speaks also show in a box above the prompt. You can talk at any time: while Claude is working, your words are passed to it mid-task; while it is speaking, it stops and listens. You don't press anything.

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
| Say something | Just talk. Pause for 3 seconds to send it. A short pop plays when it is sent. |
| Add something while Claude works | Just talk. It waits in a numbered list above the prompt until Claude's next step; if the turn ends first, it is sent as your next prompt. |
| Ignore more background sound | `/talk level 0.05` (default 0.03). Takes effect at once. |
| Change the voice | `/talk voice bm_george`. Plays a sample at once. `/talk voice` lists the choices. |
| Interrupt Claude's speech | Start talking. It stops right away. |
| Discard what you just said | Say "never mind" |
| Type instead | Type a prompt. Speech stops; voice mode stays on. |
| Stop Claude's work | Press Esc. Voice mode stays on. |
| Stop voice mode | Type `/talk` again |

Use headphones. With speakers, the microphone hears Claude's voice and can mistake it for you interrupting. If you use speakers, raise `NO_HANDS_BARGE`.

Above the prompt, a box shows the last thing Claude said, and a line under it shows what is happening: a green wave while listening, with your words as you say them; a cyan wave while Claude speaks; a spinner while it works.

## How it works

`voiced.py` is a small local server that keeps both speech models loaded and the microphone open. `/talk` starts it through the `voiced` launcher, and the mod talks to it over a Unix socket. It quits when voice mode turns off, or after 15 minutes with no connection.

1. **Listen.** Speech starts when sound goes above 3% volume and ends after 3 seconds below it. About once a second, Whisper large-v3-turbo transcribes what you have said so far, and the indicator shows it. To keep stray sound out, the server drops: sound louder than the threshold for less than 0.4 seconds in total; segments Whisper rates as likely not speech or as repetitive (its usual way of hallucinating on noise); and transcripts made only of filler like "Thank you." or "you".
2. **Send.** If Claude is idle, your words are submitted as your prompt. If it is working, they are added to the next tool result as a note from you, which Claude reads mid-task.
3. **Heads-up and updates.** While voice mode is on, the mod adds one paragraph to the system prompt asking Claude to talk like a colleague: answer directly, give a one-sentence heads-up before tool work, and mention only what is worth knowing during long work. The mod speaks the heads-up at the first tool call, and later notes at most every 20 seconds.
4. **Reply.** A short plain answer is spoken as written. A longer one is rewritten for speech first: the mod sends a copy of the conversation, with the same model, asking for the result and anything you need to know in one to three sentences. Most of that request is served from the prompt cache. The reply on screen is unchanged.
5. **Speak.** Kokoro, an 82-million-parameter text-to-speech model, turns the whole reply into audio in one pass and plays it. Two sentences take about 0.3 seconds to generate. Speech waits while you are talking, and stops if you start. If the server cannot speak, the macOS `say` voice reads it instead.

No audio leaves the machine.

## Settings

`/talk voice` and `/talk level` change these for the current session. To keep a choice, set it in your shell profile and restart Claude Code:

| Variable | Default | Meaning |
|---|---|---|
| `NO_HANDS_VOICE` | `af_heart` | Kokoro voice. The first letter sets the accent: `a` American, `b` British. The second sets female or male. Examples: `af_bella`, `am_michael`, `bf_emma`, `bm_george`. |
| `NO_HANDS_SPEED` | `1.0` | Speaking rate. `1.2` is 20% faster. |
| `NO_HANDS_PAUSE` | `3.0` | Seconds of silence that send what you said. |
| `NO_HANDS_LEVEL` | `0.03` | Volume, from 0 to 1, that counts as speech. Raise it in a loud room. |
| `NO_HANDS_BARGE` | twice `NO_HANDS_LEVEL` | Volume that counts as you interrupting while Claude speaks. Raise it if you use speakers. |

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
- There is no echo cancellation. With speakers, Claude's own voice can trigger an interruption.
- Claude Code mods are an early-access feature, and the API may change between Claude Code releases.

## License

MIT
