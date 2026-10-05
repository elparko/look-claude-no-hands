#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
dir=${TMPDIR:-/tmp}/claude-voice-talk
mkdir -p $dir
rm -f $dir/reply.wav
voice=${NO_HANDS_VOICE:-af_heart}

mlx_audio.tts.generate --model mlx-community/Kokoro-82M-bf16 --voice $voice --lang_code ${voice[1]} \
  --speed ${NO_HANDS_SPEED:-1.0} --text "$1" --output_path $dir --file_prefix reply \
  --join_audio --audio_format wav >/dev/null 2>&1 || exit $?
afplay $dir/reply.wav
