#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
dir=${TMPDIR:-/tmp}/claude-voice-talk
mkdir -p $dir
rm -f $dir/turn.wav $dir/turn.txt

if [[ ${1:-} == --file ]]; then
  cp "$2" $dir/turn.wav
else
  afplay /System/Library/Sounds/Tink.aiff
  rec -q -c 1 -r 16000 $dir/turn.wav silence 1 0.1 3% 1 2.0 3% trim 0 120 2>/dev/null || exit 1
fi

mlx_whisper $dir/turn.wav --model mlx-community/whisper-large-v3-turbo \
  --language en --output-format txt --output-dir $dir --verbose False >/dev/null 2>&1 || exit 2
cat $dir/turn.txt
