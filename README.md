# Look Claude, no hands

Hands-free voice mode for Claude Code on macOS.

Type `/talk` once. After that you just talk. Claude answers out loud, and the words it speaks also show in a box above the prompt. You can talk at any time: while Claude is working, your words are passed to it mid-task; while it is speaking, it stops and listens. You don't press anything.

## Install

Requirements:

- A Mac with Apple Silicon (M1 or later). Speech-to-text and text-to-speech both use MLX, Apple's machine-learning framework, which needs it.
- Claude Code 2.1.289 or later. The mod uses Claude Code's function hooks, an early-access feature; it was built and tested on 2.1.289.
- `uv`, the Python tool installer

1. Install the mod:

   ```
   claude plugin marketplace add elparko/look-claude-no-hands
   claude plugin install no-hands@no-hands
   ```

2. Restart Claude Code, or run `/reload-plugins`.

3. Type `/talk`. macOS asks to give your terminal app microphone access the first time. Allow it.

The first `/talk` takes a few minutes: `uv` installs the Python packages, and two models download once: Whisper, which turns your speech into text (1.6 GB), and Kokoro, which speaks the replies (340 MB). After that, starting takes about 8 seconds. To download less, see [Smaller downloads](#smaller-downloads).

## Use

| Action | How |
|---|---|
| Start | Type `/talk` |
| Say something | Just talk. Pause for 3 seconds to send it. A short pop plays when it is sent. |
| Ask a quick question while Claude works | Just ask. A question (or anything starting with "by the way" or "quick question") is answered right away from what Claude already knows, without interrupting the work, like `/btw`. If it is really an instruction, it goes to the queue instead. |
| Add something while Claude works | Just talk. It waits in a numbered list above the prompt until Claude's next step; if the turn ends first, it is sent as your next prompt. |
| Ignore more background sound | `/talk level 0.05` (default 0.03). Takes effect at once. |
| Change the voice | `/talk voice bm_george`. Plays a sample at once. `/talk voice` lists the choices. |
| Change the speech recognition model | `/talk model small`. Choices: `turbo`, `small`, `base`, `tiny`. A model downloads the first time you pick it. |
| Interrupt Claude's speech | Start talking. It stops right away. |
| Remove the last queued item | Say "cancel" or "scratch that" |
| Empty the queue | Say "clear queue" |
| Run a slash command | Say "slash" and the command anywhere in a sentence, like "slash code review high" or "finish the audit fixes, slash goal". Claude reads it back ("Run goal with: finish the audit fixes. Okay?") and runs it when you say "yes" or "go ahead". Say "no" to drop it. If you said only "slash goal", it asks what the goal should be first. |
| Message one agent | Say "tell agent 2 to skip the tests" or "ask the reviewer what it found". Agents go by number or by words from their name. |
| Stop one agent | Say "stop agent 2", or "stop" and the agent's exact name |
| Hear what the agents are doing | Say "agent status" |
| Send the queue right away | Say "send now" or "next". Claude's current step stops and the queue is sent as your next prompt. |
| Discard what you just said | Say "never mind" |
| Type instead | Type a prompt. Speech stops; voice mode stays on. |
| Stop Claude's work | Press Esc, or say "stop". Voice mode stays on. Anything still queued is dropped, and Claude says so. |
| Stop voice mode | Type `/talk` again. `/reload-plugins` also turns it off. |

Voice works in one Claude Code session at a time. Running `/talk` in a second session moves the microphone there, and the first session turns voice off with a notice.

If the microphone stops sending sound (headphones unplugged, for example), voice mode turns off with a notice. Run `/talk` again to pick up the current microphone.

Use headphones. With speakers, the microphone hears Claude's voice and can mistake it for you interrupting. If you use speakers, raise `NO_HANDS_BARGE`.

Above the prompt, one panel shows what is happening: a green wave while listening, a cyan wave while Claude speaks, and a spinner while it works. Under that it shows the last thing Claude received (Sent), Claude's reply to it, your words as you say them (Hearing), and anything waiting for Claude. The border color follows the state.

## Agents

When Claude starts subagents, the voice panel lists them under "Agents": number, name, how long each has run, and the tool it is using now. Agents started by other agents are indented under them. Up to six show, running agents first. While voice mode is on, Claude is asked to give each agent a short name so you can address it by voice.

Your message to an agent goes into that agent's conversation as a message, the same way Claude's own SendMessage tool delivers one. While Claude is working, finished agents are announced together every few seconds, so many agents finishing at once give one sentence.

Agents run by a workflow are not listed; the API the mod uses does not report them.

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
| `NO_HANDS_VOICE` | `af_bella` | Kokoro voice. The first letter sets the accent: `a` American, `b` British. The second sets female or male. Examples: `af_heart`, `am_michael`, `bf_emma`, `bm_george`. |
| `NO_HANDS_SPEED` | `1.0` | Speaking rate. `1.2` is 20% faster. |
| `NO_HANDS_PAUSE` | `3.0` | Seconds of silence that send what you said. |
| `NO_HANDS_LEVEL` | `0.03` | Volume, from 0 to 1, that counts as speech. Raise it in a loud room. |
| `NO_HANDS_BARGE` | twice `NO_HANDS_LEVEL` | Volume that counts as you interrupting while Claude speaks. Raise it if you use speakers. |
| `NO_HANDS_WHISPER` | `turbo` | Speech recognition model: `turbo`, `small`, `base`, `tiny`, or any MLX Whisper repo on Hugging Face (`mlx-community/whisper-medium.en-mlx`). |
| `NO_HANDS_TTS` | `kokoro` | `say` uses the built-in macOS voice instead of Kokoro, so Kokoro never downloads. |

The full voice list is on the [Kokoro model page](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md).

## Smaller downloads

Only the models you use are downloaded. Two choices set the size.

**Speech recognition.** Set `NO_HANDS_WHISPER`, or switch during a session with `/talk model`:

| Model | Download | Notes |
|---|---|---|
| `turbo` | 1.6 GB | Default. Fewest mistakes. |
| `small` | 480 MB | English only. Good in a quiet room. |
| `base` | 145 MB | English only. Misses more words. |
| `tiny` | 75 MB | English only. Fastest, most mistakes. |

**Claude's voice.** Kokoro is 340 MB, all its voices included (27 MB of that). Changing voices with `/talk voice` downloads nothing new. For no download at all, set `NO_HANDS_TTS=say` to use the macOS voice; it uses the System Voice set in System Settings > Accessibility. It sounds more robotic, and `/talk voice` does nothing in this mode.

The lightest setup is about 75 MB of models plus the Python packages:

```
export NO_HANDS_WHISPER=tiny
export NO_HANDS_TTS=say
```

Add those lines to your shell profile (`~/.zshrc`) and restart Claude Code.

**Remove a model you no longer use.** Models are stored by Hugging Face under `~/.cache/huggingface/hub`, one folder each. To see them and their sizes:

```
du -sh ~/.cache/huggingface/hub/models--mlx-community--*
```

Delete a folder to free its space; the model downloads again if you pick it later:

```
rm -rf ~/.cache/huggingface/hub/models--mlx-community--whisper-large-v3-turbo
rm -rf ~/.cache/huggingface/hub/models--mlx-community--Kokoro-82M-bf16
```

To remove everything the mod downloaded, delete those model folders and run `uv cache clean`, which also removes the Python packages (and anything else `uv` has cached).

## Files

```
hooks/register.tsx       the mod: /talk command, the listen and speak loop, agent tracking, the indicator band
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
