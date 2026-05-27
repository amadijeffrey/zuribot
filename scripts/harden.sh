#!/usr/bin/env bash
#
# Optional SSH hardening: create a non-root `deploy` user, copy your SSH key
# across, disable root login + password auth. Must be run as root, ideally
# right after you first SSH into a fresh VM.
#
#   sudo ./scripts/harden.sh
#
# After this finishes, log out and reconnect as deploy@<VM_IP>.

set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%swarn:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo ./scripts/harden.sh"

USERNAME="${DEPLOY_USER:-deploy}"

if id "$USERNAME" >/dev/null 2>&1; then
  info "User $USERNAME already exists"
else
  info "Creating user $USERNAME"
  adduser --disabled-password --gecos "" "$USERNAME"
  usermod -aG sudo "$USERNAME"
fi

# Copy root's authorized_keys to the new user, if present
if [[ -f /root/.ssh/authorized_keys ]]; then
  info "Copying SSH authorized_keys to $USERNAME"
  install -d -m 700 -o "$USERNAME" -g "$USERNAME" "/home/$USERNAME/.ssh"
  install -m 600 -o "$USERNAME" -g "$USERNAME" \
    /root/.ssh/authorized_keys "/home/$USERNAME/.ssh/authorized_keys"
else
  warn "/root/.ssh/authorized_keys not found — make sure $USERNAME has an SSH key before locking root out"
  read -r -p "continue anyway? [y/N] " ans
  [[ "$ans" == "y" || "$ans" == "Y" ]] || die "aborting"
fi

info "Disabling root SSH login + password auth"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/'           /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config

info "Reloading sshd"
systemctl restart ssh

info "Setting timezone to UTC"
timedatectl set-timezone UTC

cat <<EOF

${GREEN}Hardening complete.${RESET}

  Log out and reconnect as:  ssh ${USERNAME}@<VM_IP>
  Then clone the repo to /opt/zuribot and run ./scripts/setup.sh

EOF
