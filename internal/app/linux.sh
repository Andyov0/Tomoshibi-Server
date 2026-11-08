#!/bin/sh
# Installs the Tomoshibi app for Linux from @BASE@, for the person running it.
#
#   curl -fsSL @BASE@/linux.sh | sh
#   wget -qO- @BASE@/linux.sh | sh
#
# Options, after "sh -s --":
#   --force       install on a machine where no desktop was found, or as root
#   --uninstall   remove what this installed (the settings stay)
#   --help        say this
#
# What it does: checks that this is a Linux machine with a desktop, picks the
# build for this processor (x86-64 or ARM64), checks the C library is new
# enough, downloads the app from the deployment above, checks its size and
# SHA-256 against what the deployment lists, and puts it in
# ~/.local/share/tomoshibi with a launcher in ~/.local/bin and an entry in the
# desktop's apps. Nothing outside your own home folder is touched, and sudo is
# never run. The app updates itself from then on.
set -eu

BASE='@BASE@'
VERSION=1
# The oldest C library the app runs on: it is built on Ubuntu 24.04.
MIN_GLIBC=2.39
APP_ID=app.tomoshibi.Linux

DATA=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
DIR=$DATA/tomoshibi
IMAGE=$DIR/Tomoshibi.AppImage
BIN=$HOME/.local/bin/tomoshibi
ENTRY=$DATA/applications/$APP_ID.desktop
HICOLOR=$DATA/icons/hicolor

# The language of the messages: the terminal's, where it is one the app speaks.
lang=en
case ${LC_ALL:-${LC_MESSAGES:-${LANG:-}}} in
zh_TW* | zh_HK* | zh_MO* | zh_Hant*) lang=zh_hant ;;
zh*) lang=zh_hans ;;
ja*) lang=ja ;;
esac

force=0
action=install
unknown=
for arg in "$@"; do
	case $arg in
	--force) force=1 ;;
	--uninstall) action=uninstall ;;
	--help | -h) action=help ;;
	*) unknown=$arg ;;
	esac
done


# Every name in these sentences is written ${NAME}: a name followed straight by a
# Chinese or Japanese character, as in "$DIR，", was read by sh in a locale it did not
# have as a longer name ending in that character's first byte, and set -u stopped
# the script with "DIR\xef: unbound variable" instead of the sentence.
say() {
	case ${lang}:$1 in
	en:unknown) echo "Unknown option: $2 (try --help)" ;;
	zh_hans:unknown) echo "不认识的选项：$2（可以用 --help 看看有哪些）" ;;
	zh_hant:unknown) echo "不認得的選項：$2（可以用 --help 看看有哪些）" ;;
	ja:unknown) echo "不明なオプションです：$2（--help で一覧を表示できます）" ;;

	en:help) cat <<EOF
Installs the Tomoshibi app for Linux from ${BASE}, for the person running it.

  curl -fsSL ${BASE}/linux.sh | sh
  curl -fsSL ${BASE}/linux.sh | sh -s -- --uninstall

  --force       install on a machine where no desktop was found, or as root
  --uninstall   remove what this installed (the settings stay)
  --help        say this

It picks the build for this processor (x86-64 or ARM64), checks its size and
SHA-256, and puts it in ${DIR}, with a launcher in
${HOME}/.local/bin and an entry among the desktop's apps. sudo is never run.
EOF
		;;
	zh_hans:help) cat <<EOF
从 ${BASE} 安装 Linux 版 Tomoshibi，装给正在运行这条命令的人。

  curl -fsSL ${BASE}/linux.sh | sh
  curl -fsSL ${BASE}/linux.sh | sh -s -- --uninstall

  --force       没检测到桌面、或者用 root 运行时，照样安装
  --uninstall   删掉这条命令装的东西（设置会保留）
  --help        显示这段说明

它会自己选这台电脑处理器对应的版本（x86-64 或 ARM64），校验大小和 SHA-256，
装到 ${DIR}，在 ${HOME}/.local/bin 放一个启动命令，
并加进桌面的应用列表。全程不会用 sudo。
EOF
		;;
	zh_hant:help) cat <<EOF
從 ${BASE} 安裝 Linux 版 Tomoshibi，裝給正在執行這條指令的人。

  curl -fsSL ${BASE}/linux.sh | sh
  curl -fsSL ${BASE}/linux.sh | sh -s -- --uninstall

  --force       沒偵測到桌面、或者用 root 執行時，照樣安裝
  --uninstall   刪掉這條指令裝的東西（設定會保留）
  --help        顯示這段說明

它會自己選這台電腦處理器對應的版本（x86-64 或 ARM64），校驗大小和 SHA-256，
裝到 ${DIR}，在 ${HOME}/.local/bin 放一個啟動指令，
並加進桌面的 App 列表。全程不會用 sudo。
EOF
		;;
	ja:help) cat <<EOF
${BASE} から Linux 版 Tomoshibi を、このコマンドを実行した人のためにインストールします。

  curl -fsSL ${BASE}/linux.sh | sh
  curl -fsSL ${BASE}/linux.sh | sh -s -- --uninstall

  --force       デスクトップが見つからない場合や root でも、インストールします
  --uninstall   このコマンドでインストールしたものを削除します（設定は残ります）
  --help        この説明を表示します

このコンピューターのプロセッサーに合った版（x86-64 または ARM64）を選び、
サイズと SHA-256 を確かめて ${DIR} に入れ、
${HOME}/.local/bin に起動コマンドを置き、デスクトップのアプリ一覧に追加します。sudo は使いません。
EOF
		;;

	en:not_linux) echo "This installs the Linux app, and this machine is $2." ;;
	zh_hans:not_linux) echo "这是 Linux 版的安装命令，而这台机器是 $2。" ;;
	zh_hant:not_linux) echo "這是 Linux 版的安裝指令，而這台機器是 $2。" ;;
	ja:not_linux) echo "これは Linux 版のインストールコマンドですが、このマシンは $2 です。" ;;

	en:root) echo "Run it as yourself, not as root or with sudo: the app is installed for one person, in their home folder. (--force installs it for root.)" ;;
	zh_hans:root) echo "请用你自己的账号运行，不要用 root 或 sudo：应用装在你自己的主目录里，只给你用。（加 --force 可以装给 root。）" ;;
	zh_hant:root) echo "請用你自己的帳號執行，不要用 root 或 sudo：App 裝在你自己的主目錄裡，只給你用。（加 --force 可以裝給 root。）" ;;
	ja:root) echo "root や sudo ではなく、自分のユーザーで実行してください。アプリは自分のホームフォルダーにインストールされます。（--force を付けると root にもインストールします。）" ;;

	en:no_desktop) echo "Tomoshibi is a desktop app, and this machine has no desktop (no graphical session, and no desktop environment installed). If it does have one, run this again with --force:" ;;
	zh_hans:no_desktop) echo "Tomoshibi 是桌面应用，这台机器没有桌面（没有图形会话，也没装桌面环境）。如果它其实有桌面，加上 --force 再运行一次：" ;;
	zh_hant:no_desktop) echo "Tomoshibi 是桌面 App，這台機器沒有桌面（沒有圖形工作階段，也沒裝桌面環境）。如果它其實有桌面，加上 --force 再執行一次：" ;;
	ja:no_desktop) echo "Tomoshibi はデスクトップアプリですが、このマシンにはデスクトップがありません（グラフィカルセッションもデスクトップ環境もありません）。実際にはある場合は、--force を付けてもう一度実行してください：" ;;

	en:arch) echo "This processor ($2) is not supported yet: there are builds for x86-64 and ARM64." ;;
	zh_hans:arch) echo "暂时还不支持这种处理器（$2）：目前只有 x86-64 和 ARM64 两种版本。" ;;
	zh_hant:arch) echo "暫時還不支援這種處理器（$2）：目前只有 x86-64 和 ARM64 兩種版本。" ;;
	ja:arch) echo "このプロセッサー（$2）にはまだ対応していません。x86-64 版と ARM64 版があります。" ;;

	en:bits32) echo "This system is 32-bit, and the app needs a 64-bit one." ;;
	zh_hans:bits32) echo "这个系统是 32 位的，应用需要 64 位系统。" ;;
	zh_hant:bits32) echo "這個系統是 32 位元的，App 需要 64 位元系統。" ;;
	ja:bits32) echo "このシステムは 32 ビットです。アプリには 64 ビットのシステムが必要です。" ;;

	en:musl) echo "This system uses musl (Alpine or similar), and the app needs the GNU C library. It runs on Ubuntu 24.04, Debian 13, Fedora 40 or newer." ;;
	zh_hans:musl) echo "这个系统用的是 musl（Alpine 之类），应用需要 GNU C 库。可以在 Ubuntu 24.04、Debian 13、Fedora 40 或更新的系统上运行。" ;;
	zh_hant:musl) echo "這個系統用的是 musl（Alpine 之類），App 需要 GNU C 函式庫。可以在 Ubuntu 24.04、Debian 13、Fedora 40 或更新的系統上執行。" ;;
	ja:musl) echo "このシステムは musl（Alpine など）を使っていますが、アプリには GNU C ライブラリが必要です。Ubuntu 24.04、Debian 13、Fedora 40 以降で動きます。" ;;

	en:old) echo "This system is too old for the app (C library $2; it needs ${MIN_GLIBC} or newer: Ubuntu 24.04, Debian 13, Fedora 40 or newer)." ;;
	zh_hans:old) echo "这个系统对应用来说太旧了（C 库 $2，需要 ${MIN_GLIBC} 或更新：Ubuntu 24.04、Debian 13、Fedora 40 或更新）。" ;;
	zh_hant:old) echo "這個系統對 App 來說太舊了（C 函式庫 $2，需要 ${MIN_GLIBC} 或更新：Ubuntu 24.04、Debian 13、Fedora 40 或更新）。" ;;
	ja:old) echo "このシステムはアプリには古すぎます（C ライブラリ $2。${MIN_GLIBC} 以降が必要です：Ubuntu 24.04、Debian 13、Fedora 40 以降）。" ;;

	en:no_fetch) echo "Neither curl nor wget is installed; install one of them and run this again." ;;
	zh_hans:no_fetch) echo "没有装 curl 也没有装 wget，请装上其中一个再运行。" ;;
	zh_hant:no_fetch) echo "沒有裝 curl 也沒有裝 wget，請裝上其中一個再執行。" ;;
	ja:no_fetch) echo "curl も wget もありません。どちらかをインストールしてから、もう一度実行してください。" ;;

	en:no_sum) echo "No program to check the download with (sha256sum, shasum or openssl); install coreutils and run this again." ;;
	zh_hans:no_sum) echo "没有能校验下载的程序（sha256sum、shasum 或 openssl），请装上 coreutils 再运行。" ;;
	zh_hant:no_sum) echo "沒有能校驗下載的程式（sha256sum、shasum 或 openssl），請裝上 coreutils 再執行。" ;;
	ja:no_sum) echo "ダウンロードを確かめるプログラム（sha256sum、shasum、openssl）がありません。coreutils をインストールしてから、もう一度実行してください。" ;;

	en:asking) echo "Asking ${BASE} for the newest Linux app ($2)..." ;;
	zh_hans:asking) echo "正在向 ${BASE} 查询最新的 Linux 版（$2）……" ;;
	zh_hant:asking) echo "正在向 ${BASE} 查詢最新的 Linux 版（$2）……" ;;
	ja:asking) echo "${BASE} に最新の Linux 版（$2）を問い合わせています……" ;;

	en:unreachable) echo "Could not reach ${BASE}, or it offers no Linux app for $2. Try again in a moment." ;;
	zh_hans:unreachable) echo "连不上 ${BASE}，或者它没有 $2 的 Linux 版。请稍后再试。" ;;
	zh_hant:unreachable) echo "連不上 ${BASE}，或者它沒有 $2 的 Linux 版。請稍後再試。" ;;
	ja:unreachable) echo "${BASE} に接続できないか、$2 の Linux 版がありません。しばらくしてからもう一度お試しください。" ;;

	en:current) echo "Tomoshibi $2 is already installed and up to date." ;;
	zh_hans:current) echo "Tomoshibi $2 已经装好了，是最新版。" ;;
	zh_hant:current) echo "Tomoshibi $2 已經裝好了，是最新版。" ;;
	ja:current) echo "Tomoshibi $2 はインストール済みで、最新です。" ;;

	en:downloading) echo "Downloading Tomoshibi $2 ($3 MB)..." ;;
	zh_hans:downloading) echo "正在下载 Tomoshibi $2（$3 MB）……" ;;
	zh_hant:downloading) echo "正在下載 Tomoshibi $2（$3 MB）……" ;;
	ja:downloading) echo "Tomoshibi $2（$3 MB）をダウンロードしています……" ;;

	en:bad_download) echo "The download did not match what ${BASE} lists (size or SHA-256), so nothing was installed. Try again." ;;
	zh_hans:bad_download) echo "下载的文件和 ${BASE} 列出的不一致（大小或 SHA-256），所以什么都没装。请再试一次。" ;;
	zh_hant:bad_download) echo "下載的檔案和 ${BASE} 列出的不一致（大小或 SHA-256），所以什麼都沒裝。請再試一次。" ;;
	ja:bad_download) echo "ダウンロードしたファイルが ${BASE} の一覧（サイズまたは SHA-256）と一致しないため、何もインストールしませんでした。もう一度お試しください。" ;;

	en:no_fuse) echo "One more thing: the app needs FUSE to start, and it is not installed. Install it with:" ;;
	zh_hans:no_fuse) echo "还差一样：应用启动需要 FUSE，这台机器没装。用这条命令装上：" ;;
	zh_hant:no_fuse) echo "還差一樣：App 啟動需要 FUSE，這台機器沒裝。用這條指令裝上：" ;;
	ja:no_fuse) echo "もう一つ：アプリの起動には FUSE が必要ですが、インストールされていません。次のコマンドでインストールしてください：" ;;

	en:no_fuse_other) echo "One more thing: the app needs FUSE to start, and it is not installed. Install your system's fuse3 package." ;;
	zh_hans:no_fuse_other) echo "还差一样：应用启动需要 FUSE，这台机器没装。请装上系统的 fuse3 软件包。" ;;
	zh_hant:no_fuse_other) echo "還差一樣：App 啟動需要 FUSE，這台機器沒裝。請裝上系統的 fuse3 套件。" ;;
	ja:no_fuse_other) echo "もう一つ：アプリの起動には FUSE が必要ですが、インストールされていません。システムの fuse3 パッケージをインストールしてください。" ;;

	en:done) echo "Tomoshibi $2 is installed. Open it from your apps, or run: $3" ;;
	zh_hans:done) echo "Tomoshibi $2 装好了。从应用列表里打开，或者运行：$3" ;;
	zh_hant:done) echo "Tomoshibi $2 裝好了。從 App 列表裡打開，或者執行：$3" ;;
	ja:done) echo "Tomoshibi $2 をインストールしました。アプリ一覧から開くか、次を実行してください：$3" ;;

	en:removed) echo "Tomoshibi is removed. Your settings are kept in $2; delete that folder too to forget them." ;;
	zh_hans:removed) echo "Tomoshibi 已删除。设置还留在 $2，要一起清掉就把这个文件夹也删了。" ;;
	zh_hant:removed) echo "Tomoshibi 已刪除。設定還留在 $2，要一起清掉就把這個資料夾也刪了。" ;;
	ja:removed) echo "Tomoshibi を削除しました。設定は $2 に残っています。消す場合はそのフォルダーも削除してください。" ;;

	en:nothing) echo "Tomoshibi is not installed here (nothing at ${IMAGE})." ;;
	zh_hans:nothing) echo "这里没有装 Tomoshibi（${IMAGE} 不存在）。" ;;
	zh_hant:nothing) echo "這裡沒有裝 Tomoshibi（${IMAGE} 不存在）。" ;;
	ja:nothing) echo "ここには Tomoshibi はインストールされていません（${IMAGE} がありません）。" ;;
	esac
}

die() {
	say "$@" >&2
	exit 1
}

# Said from here rather than read from "$0", which is "sh" when this arrives
# through a pipe.
if [ -n "$unknown" ]; then
	die unknown "$unknown"
fi
if [ "$action" = help ]; then
	say help
	exit 0
fi

# --- what is on this machine ------------------------------------------------

# A desktop: a graphical session where this runs, or one installed on the
# machine for somebody who came in over SSH. Not systemd's default target:
# Ubuntu's server images say graphical.target with no desktop at all.
has_desktop() {
	[ -n "${WAYLAND_DISPLAY:-}" ] && return 0
	[ -n "${DISPLAY:-}" ] && return 0
	[ -n "${XDG_CURRENT_DESKTOP:-}" ] && return 0
	case ${XDG_SESSION_TYPE:-} in x11 | wayland) return 0 ;; esac
	if command -v loginctl >/dev/null 2>&1; then
		me=$(id -un)
		for session in $(loginctl list-sessions --no-legend 2>/dev/null | while read -r id _ user _; do [ "$user" = "$me" ] && echo "$id"; done); do
			case $(loginctl show-session "$session" -p Type --value 2>/dev/null) in
			x11 | wayland | mir) return 0 ;;
			esac
		done
	fi
	for folder in /usr/share/wayland-sessions /usr/share/xsessions; do
		for file in "$folder"/*.desktop; do
			[ -e "$file" ] && return 0
		done
	done
	[ -e /etc/systemd/system/display-manager.service ] && return 0
	return 1
}

# The C library's version, or "musl", or nothing where neither can be read.
# Without awk, which a minimal openSUSE does not have: there it once read
# 2.44 as too old to run anything.
libc() {
	version=$(getconf GNU_LIBC_VERSION 2>/dev/null) || version=
	version=${version#glibc }
	if [ -z "$version" ]; then
		said=$(ldd --version 2>&1 || true)
		case $said in
		*musl*) echo musl; return ;;
		esac
		version=$(printf '%s\n' "$said" | sed -n '1s/.* \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p')
	fi
	echo "$version"
}

# Whether version $1 is at least $2, by their first two numbers. A version
# that cannot be read is taken to be new enough: the app says so itself on an
# older system, and refusing a system this cannot read would be the worse fault.
at_least() {
	a1=${1%%.*} a2=${1#*.} b1=${2%%.*} b2=${2#*.}
	a2=${a2%%.*} b2=${b2%%.*}
	case $a1:$a2 in *[!0-9:]* | :* | *:) return 0 ;; esac
	[ "$a1" -gt "$b1" ] && return 0
	[ "$a1" -eq "$b1" ] && [ "$a2" -ge "$b2" ]
}

fetch() { # url file
	agent="Tomoshibi/installer-$VERSION (Linux; installer; $arch)"
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 2 -A "$agent" -o "$2" "$1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -U "$agent" -O "$2" "$1"
	else
		die no_fetch
	fi
}

sum_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	elif command -v shasum >/dev/null 2>&1; then
		shasum -a 256 "$1" | cut -d ' ' -f 1
	elif command -v openssl >/dev/null 2>&1; then
		openssl dgst -sha256 "$1" | sed 's/.*= *//'
	else
		die no_sum
	fi
}

real_path() {
	readlink -f "$1" 2>/dev/null || realpath "$1" 2>/dev/null || echo "$1"
}

# --- the desktop entry, as the app writes it (linux/src/update/desktop.rs) ---

# A desktop entry's string value: a backslash doubled.
escaped() { printf '%s' "$1" | sed 's/\\/\\\\/g'; }

# The image as the program of an Exec line: as it is where it holds only
# characters nothing reads specially (every home folder seen so far), and
# otherwise quoted, the four characters the quoting rule reserves escaped, and
# every backslash doubled again for the string value, as the app does. Unquoted
# where it can be, because xdg-open's generic opener cannot run a quoted
# program (desktop.rs, exec_argument).
exec_argument() {
	case $1 in
	*[!A-Za-z0-9/._+@=,-]*)
		quoted=$(printf '%s' "$1" | sed -e 's/[\\"`$]/\\&/g' -e 's/%/%%/g')
		printf '"%s"' "$quoted" | sed 's/\\/\\\\/g'
		;;
	*) printf '%s' "$1" ;;
	esac
}

# Writes the entry, the icons and the default handler for the image at $1,
# from the image's own entry and icons, so that the app finds itself listed and
# does not ask again.
integrate() {
	command -v awk >/dev/null 2>&1 || return 1
	image=$1
	work=$(mktemp -d)
	(
		cd "$work"
		"$image" --appimage-extract "$APP_ID.desktop" >/dev/null 2>&1 || true
		"$image" --appimage-extract "usr/share/icons/hicolor/*" >/dev/null 2>&1 || true
	)
	own=$work/squashfs-root/$APP_ID.desktop
	if [ ! -f "$own" ]; then
		rm -rf "$work"
		return 1
	fi

	mkdir -p "$HICOLOR"
	if [ -d "$work/squashfs-root/usr/share/icons/hicolor" ]; then
		(cd "$work/squashfs-root/usr/share/icons/hicolor" && find . -name "$APP_ID.*" -type f) | while read -r icon; do
			mkdir -p "$HICOLOR/$(dirname "$icon")"
			cp -f "$work/squashfs-root/usr/share/icons/hicolor/$icon" "$HICOLOR/$icon"
		done
	fi
	: >"$HICOLOR/.$APP_ID.touch" 2>/dev/null && rm -f "$HICOLOR/.$APP_ID.touch"

	mkdir -p "$(dirname "$ENTRY")"
	value=$(escaped "$image")
	program=$(exec_argument "$image")
	awk -v value="$value" -v program="$program" '
		/^Exec=/ { print "TryExec=" value; print "Exec=" program " %U"; next }
		/^TryExec=/ || /^X-Tomoshibi-Image=/ { next }
		{ print }
		END { print "X-Tomoshibi-Image=" value }
	' "$own" >"$ENTRY.$$.part"
	mv -f "$ENTRY.$$.part" "$ENTRY"
	rm -rf "$work"

	default_handler
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" 2>/dev/null || true
	command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f "$HICOLOR" 2>/dev/null || true
	return 0
}

# tomoshibi:// opened by this app: the default in mimeapps.list, and first among
# the added associations, keeping everything else in the file.
default_handler() {
	list=$CONFIG/mimeapps.list
	mkdir -p "$CONFIG"
	[ -f "$list" ] || : >"$list"
	awk -v id="$APP_ID.desktop" '
		function flush() {
			if (section == "[Default Applications]" && !defaulted) { print "x-scheme-handler/tomoshibi=" id; defaulted = 1 }
			if (section == "[Added Associations]" && !added) { print "x-scheme-handler/tomoshibi=" id ";"; added = 1 }
		}
		/^\[/ { flush(); section = $0; print; next }
		section == "[Default Applications]" && /^x-scheme-handler\/tomoshibi=/ { print "x-scheme-handler/tomoshibi=" id; defaulted = 1; next }
		section == "[Added Associations]" && /^x-scheme-handler\/tomoshibi=/ {
			rest = substr($0, index($0, "=") + 1); kept = id ";"
			n = split(rest, parts, ";")
			for (i = 1; i <= n; i++) if (parts[i] != "" && parts[i] != id) kept = kept parts[i] ";"
			print "x-scheme-handler/tomoshibi=" kept; added = 1; next
		}
		{ print }
		END {
			flush()
			if (!defaulted) { print ""; print "[Default Applications]"; print "x-scheme-handler/tomoshibi=" id }
			if (!added) { print ""; print "[Added Associations]"; print "x-scheme-handler/tomoshibi=" id ";" }
		}
	' "$list" >"$list.$$.part"
	mv -f "$list.$$.part" "$list"
}

# --- uninstall --------------------------------------------------------------

if [ "$action" = uninstall ]; then
	[ -e "$IMAGE" ] || [ -e "$ENTRY" ] || die nothing
	rm -f "$IMAGE"
	rmdir "$DIR" 2>/dev/null || true
	# Only a launcher and an entry this or the app wrote.
	[ -f "$BIN" ] && grep -q "Tomoshibi.AppImage" "$BIN" 2>/dev/null && rm -f "$BIN"
	[ -f "$ENTRY" ] && grep -q '^X-Tomoshibi-Image=' "$ENTRY" 2>/dev/null && rm -f "$ENTRY"
	find "$HICOLOR" -name "$APP_ID.*" -type f -exec rm -f {} + 2>/dev/null || true
	if [ -f "$CONFIG/mimeapps.list" ] && command -v awk >/dev/null 2>&1; then
		awk -v id="$APP_ID.desktop" '
			/^x-scheme-handler\/tomoshibi=/ {
				rest = substr($0, index($0, "=") + 1); kept = ""
				n = split(rest, parts, ";")
				for (i = 1; i <= n; i++) if (parts[i] != "" && parts[i] != id) kept = kept parts[i] (n > 1 ? ";" : "")
				if (kept != "") print "x-scheme-handler/tomoshibi=" kept
				next
			}
			{ print }
		' "$CONFIG/mimeapps.list" >"$CONFIG/mimeapps.list.$$.part" && mv -f "$CONFIG/mimeapps.list.$$.part" "$CONFIG/mimeapps.list"
	fi
	command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$DATA/applications" 2>/dev/null || true
	say removed "$CONFIG/tomoshibi"
	exit 0
fi

# --- install ----------------------------------------------------------------

system=$(uname -s)
[ "$system" = Linux ] || die not_linux "$system"

if [ "$(id -u)" = 0 ] && [ "$force" = 0 ]; then
	die root
fi

if [ "$force" = 0 ] && ! has_desktop; then
	say no_desktop >&2
	echo "  curl -fsSL $BASE/linux.sh | sh -s -- --force" >&2
	exit 1
fi

machine=$(uname -m)
case $machine in
x86_64 | amd64) arch=x86_64 ;;
aarch64 | arm64) arch=aarch64 ;;
*) die arch "$machine" ;;
esac
if [ "$(getconf LONG_BIT 2>/dev/null || echo 64)" = 32 ]; then
	die bits32
fi

c=$(libc)
[ "$c" = musl ] && die musl
if [ -n "$c" ] && ! at_least "$c" "$MIN_GLIBC"; then
	die old "$c"
fi

# The line the deployment lists for this processor, read without jq: the
# deployment writes it on one line, and only these four fields are needed.
mkdir -p "$DIR"
line=$DIR/.line.$$
trap 'rm -f "$line" "$IMAGE.$$.part"' EXIT
trap 'exit 130' INT TERM
say asking "$arch"
fetch "$BASE/api/apps/latest/linux-$arch" "$line" || die unreachable "$arch"
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$line"; }
version=$(field version)
file=$(field file)
want_sum=$(field sha256)
want_size=$(sed -n 's/.*"size":\([0-9][0-9]*\).*/\1/p' "$line")
case $version in '' | *[!0-9.]*) die unreachable "$arch" ;; esac
case $want_sum in *[!0-9a-f]* | '') die unreachable "$arch" ;; esac
[ ${#want_sum} -eq 64 ] || die unreachable "$arch"
case $want_size in '' | *[!0-9]*) die unreachable "$arch" ;; esac
: "$file"

if [ -f "$IMAGE" ] && [ "$(sum_of "$IMAGE")" = "$want_sum" ]; then
	say current "$version"
else
	tenths=$(((want_size * 10 + 524288) / 1048576))
	say downloading "$version" "$((tenths / 10)).$((tenths % 10))"
	part=$IMAGE.$$.part
	fetch "$BASE/api/apps/latest/linux-$arch/file" "$part" || die unreachable "$arch"
	got_size=$(wc -c <"$part" | tr -d ' ')
	if [ "$got_size" != "$want_size" ] || [ "$(sum_of "$part")" != "$want_sum" ]; then
		rm -f "$part"
		die bad_download
	fi
	chmod 755 "$part"
	mv -f "$part" "$IMAGE"
fi
rm -f "$line"

image=$(real_path "$IMAGE")

# A launcher on the path, naming the image by its whole path so that the app's
# own updates, which replace the image where it is, change nothing here.
mkdir -p "$(dirname "$BIN")"
quoted=$(printf '%s' "$image" | sed "s/'/'\\\\''/g")
printf '#!/bin/sh\n# Tomoshibi.AppImage, installed by %s/linux.sh\nexec '\''%s'\'' "$@"\n' "$BASE" "$quoted" >"$BIN.$$.part"
chmod 755 "$BIN.$$.part"
mv -f "$BIN.$$.part" "$BIN"

integrate "$image" || true

if [ ! -e /dev/fuse ] || { ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; }; then
	family=
	if [ -r /etc/os-release ]; then
		family=$(. /etc/os-release && echo "${ID:-} ${ID_LIKE:-}")
	fi
	case " $family " in
	*" debian "* | *" ubuntu "*) hint="sudo apt install fuse3" ;;
	*" fedora "* | *" rhel "* | *" centos "*) hint="sudo dnf install fuse3" ;;
	*" suse "* | *" opensuse "* | *opensuse*) hint="sudo zypper install fuse3" ;;
	*" arch "*) hint="sudo pacman -S fuse3" ;;
	*) hint= ;;
	esac
	if [ -n "$hint" ]; then
		say no_fuse
		echo "  $hint"
	else
		say no_fuse_other
	fi
fi

case ":${PATH:-}:" in
*":$HOME/.local/bin:"*) start=tomoshibi ;;
*) start=$BIN ;;
esac
say done "$version" "$start"
