#!/bin/sh
set -eu

source_dir=$SCRIPT_INPUT_FILE_1
bundle_dir=$SCRIPT_OUTPUT_FILE_0
marker=__g1/build.json

if [ "$CONFIGURATION" = HostProof ]; then
    if [ ! -f "$source_dir/$marker" ]; then
        echo 'error: Run node app/host-proof/build.mjs and python3 app/scripts/prepare-ios.py --host-proof.' >&2
        exit 1
    fi
elif [ -e "$source_dir/$marker" ] || [ -L "$source_dir/$marker" ] ||
    [ -e "$bundle_dir/$marker" ] || [ -L "$bundle_dir/$marker" ]; then
    echo 'error: HostProof marker found in standard iOS web resources.' >&2
    exit 1
fi

if [ ! -f "$source_dir/index.html" ]; then
    echo 'error: Run python3 app/scripts/prepare-ios.py for the selected configuration.' >&2
    exit 1
fi

mkdir -p "$bundle_dir"
/usr/bin/rsync -a --delete "$source_dir/" "$bundle_dir/"
