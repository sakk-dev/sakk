#!/bin/sh
if [ ! -f .flaky-marker ]; then
  touch .flaky-marker
  echo 'TRANSIENT: try again' >&2
  exit 1
fi
mkdir -p out && echo data > out/data.txt
