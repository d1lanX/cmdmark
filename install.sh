#!/bin/sh
set -eu

REPOSITORY='d1lanX/cmdmark'
ASSET='cmdmark-linux-x86_64'

usage() {
	cat <<'EOF'
Install the cmdmark CLI from the latest GitHub release.

Usage: install.sh [--install-dir DIR] [--help]

The default install directory is ~/.local/bin. It can also be set with BINDIR.
EOF
}

install_dir=${BINDIR:-}
while [ "$#" -gt 0 ]; do
	case "$1" in
		--install-dir)
			if [ "$#" -lt 2 ] || [ -z "$2" ]; then
				echo 'install.sh: --install-dir requires a directory' >&2
				exit 2
			fi
			install_dir=$2
			shift 2
			;;
		--help|-h)
			usage
			exit 0
			;;
		*)
			echo "install.sh: unknown option: $1" >&2
			usage >&2
			exit 2
			;;
	esac
done

if [ "$(uname -s)" != 'Linux' ]; then
	echo 'install.sh: prebuilt cmdmark CLI is currently available only for Linux x86_64' >&2
	exit 1
fi

machine=$(uname -m)
if [ "$machine" != 'x86_64' ] && [ "$machine" != 'amd64' ]; then
	echo "install.sh: unsupported architecture: $machine (need x86_64)" >&2
	exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
	echo 'install.sh: curl is required' >&2
	exit 1
fi

if [ -z "$install_dir" ]; then
	if [ -z "${HOME:-}" ]; then
		echo 'install.sh: HOME is not set; pass --install-dir or set BINDIR' >&2
		exit 1
	fi
	install_dir=$HOME/.local/bin
fi

mkdir -p "$install_dir"
temporary_file=$(mktemp "$install_dir/.cmdmark.XXXXXX")
cleanup() {
	rm -f "$temporary_file"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

download_url="https://github.com/$REPOSITORY/releases/latest/download/$ASSET"
if ! curl --fail --location --silent --show-error --retry 3 --output "$temporary_file" "$download_url"; then
	echo 'install.sh: download failed; check that a cmdmark release is available' >&2
	exit 1
fi

if [ ! -s "$temporary_file" ]; then
	echo 'install.sh: downloaded file is empty' >&2
	exit 1
fi

chmod 0755 "$temporary_file"
mv -f "$temporary_file" "$install_dir/cmdmark"
echo "Installed cmdmark to $install_dir/cmdmark"
case ":${PATH:-}:" in
	*":$install_dir:"*) ;;
	*) echo "Add $install_dir to PATH to run cmdmark from any terminal." ;;
esac
