#!/usr/bin/env bash
# Creates (or reuses) everything Echo needs on Oracle Cloud Always Free:
# VCN, internet gateway, route, firewall rules, public subnet and one VM.
# Run in OCI Cloud Shell:  bash provision.sh
# Safe to run again: resources are found by display name and reused.
set -euo pipefail

REGION="${ECHO_REGION:-${OCI_REGION:-eu-frankfurt-1}}"
COMPARTMENT="${OCI_TENANCY:-}"            # tenancy root compartment
VM_NAME="echo-vm"
KEY="$HOME/.ssh/echo_vm"

say()  { printf '\n==> %s\n' "$*"; }
fail() { printf '\nHATA / ERROR: %s\n' "$*" >&2; exit 1; }
oci_() { oci --region "$REGION" "$@"; }
first_id() { jq -r '(.data // [])[0].id // empty'; }

command -v oci >/dev/null || fail "oci CLI not found. Run this in OCI Cloud Shell."
command -v jq  >/dev/null || fail "jq not found. Run this in OCI Cloud Shell."
[ -n "$COMPARTMENT" ] || fail "OCI_TENANCY is empty. Run this in OCI Cloud Shell."
say "Region: $REGION (Always Free resources must be in your home region)"

# --- Network -------------------------------------------------------------------
say "VCN echo-vcn"
VCN=$(oci_ network vcn list --compartment-id "$COMPARTMENT" --display-name echo-vcn --lifecycle-state AVAILABLE | first_id)
if [ -z "$VCN" ]; then
  VCN=$(oci_ network vcn create --compartment-id "$COMPARTMENT" --display-name echo-vcn \
        --cidr-blocks '["10.0.0.0/16"]' --dns-label echovcn --wait-for-state AVAILABLE | jq -r '.data.id')
  [ -n "$VCN" ] || fail "Could not create the VCN."
fi
VCN_JSON=$(oci_ network vcn get --vcn-id "$VCN")
RT=$(jq -r '.data."default-route-table-id"' <<<"$VCN_JSON")
SL=$(jq -r '.data."default-security-list-id"' <<<"$VCN_JSON")

say "Internet gateway echo-igw"
IGW=$(oci_ network internet-gateway list --compartment-id "$COMPARTMENT" --vcn-id "$VCN" --display-name echo-igw --lifecycle-state AVAILABLE | first_id)
if [ -z "$IGW" ]; then
  IGW=$(oci_ network internet-gateway create --compartment-id "$COMPARTMENT" --vcn-id "$VCN" --display-name echo-igw \
        --is-enabled true --wait-for-state AVAILABLE | jq -r '.data.id')
  [ -n "$IGW" ] || fail "Could not create the internet gateway."
fi

say "Route 0.0.0.0/0 -> internet gateway"
oci_ network route-table update --rt-id "$RT" --force --wait-for-state AVAILABLE \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null

say "Firewall (security list): allow TCP 22, 80, 443"
INGRESS='[
 {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
 {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
 {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
 {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}},
 {"source":"10.0.0.0/16","protocol":"1","isStateless":false,"icmpOptions":{"type":3}}
]'
EGRESS='[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]'
oci_ network security-list update --security-list-id "$SL" --force --wait-for-state AVAILABLE \
  --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" >/dev/null

say "Public subnet echo-subnet"
SUBNET=$(oci_ network subnet list --compartment-id "$COMPARTMENT" --vcn-id "$VCN" --display-name echo-subnet --lifecycle-state AVAILABLE | first_id)
if [ -z "$SUBNET" ]; then
  SUBNET=$(oci_ network subnet create --compartment-id "$COMPARTMENT" --vcn-id "$VCN" --display-name echo-subnet \
           --cidr-block 10.0.1.0/24 --dns-label echosubnet --route-table-id "$RT" \
           --security-list-ids "[\"$SL\"]" --prohibit-public-ip-on-vnic false \
           --wait-for-state AVAILABLE | jq -r '.data.id')
  [ -n "$SUBNET" ] || fail "Could not create the subnet."
fi

# --- SSH key -------------------------------------------------------------------
if [ ! -f "$KEY" ]; then
  say "SSH key $KEY"
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  ssh-keygen -q -t rsa -b 4096 -N "" -C echo-vm -f "$KEY"
fi

# --- cloud-init: runs once as root on the VM's first boot --------------------------
USER_DATA=$(mktemp)
trap 'rm -f "$USER_DATA"' EXIT
cat >"$USER_DATA" <<'CLOUDINIT'
#!/bin/bash
set -x
# Oracle's Ubuntu images REJECT most inbound traffic in iptables: allow 80/443
# before the REJECT rule and save (done before Docker so its rules are not saved).
for port in 443 80; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    n=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    if [ -n "$n" ]; then
      iptables -I INPUT "$n" -p tcp -m state --state NEW --dport "$port" -j ACCEPT
    fi
  fi
done
netfilter-persistent save || true

# Small VMs (E2.1.Micro has 1 GB RAM): add 2 GB swap.
if [ "$(awk '/MemTotal/{print $2}' /proc/meminfo)" -lt 3000000 ] && [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile \
    && echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io docker-compose-v2 git curl openssl jq
apt-get install -y docker-buildx || true
systemctl enable --now docker
usermod -aG docker ubuntu
mkdir -p /opt/echo && chown ubuntu:ubuntu /opt/echo
touch /opt/echo/.vm-ready
CLOUDINIT

# --- VM ------------------------------------------------------------------------
INSTANCE=$(oci_ compute instance list --compartment-id "$COMPARTMENT" --display-name "$VM_NAME" --all \
           | jq -r '[(.data // [])[] | select(."lifecycle-state" != "TERMINATED" and ."lifecycle-state" != "TERMINATING")][0].id // empty')

if [ -n "$INSTANCE" ]; then
  say "VM $VM_NAME already exists, reusing it"
  oci_ compute instance get --instance-id "$INSTANCE" --wait-for-state RUNNING >/dev/null 2>&1 \
    || fail "VM $VM_NAME exists but is not RUNNING. Start it in the console (Compute > Instances)."
else
  ADS=$(oci_ iam availability-domain list --compartment-id "$COMPARTMENT" | jq -r '.data[].name')
  [ -n "$ADS" ] || fail "No availability domains found."
  ERR=$(mktemp); OUT=$(mktemp)

  # try_launch SHAPE SHAPE_CONFIG_JSON_OR_EMPTY
  try_launch() {
    local shape=$1 config=$2 image ad args
    image=$(oci_ compute image list --compartment-id "$COMPARTMENT" --operating-system "Canonical Ubuntu" \
            --operating-system-version "24.04" --shape "$shape" --sort-by TIMECREATED --sort-order DESC --all \
            | jq -r '(.data // [])[0].id // empty')
    if [ -z "$image" ]; then echo "   no Ubuntu 24.04 image for $shape"; return 1; fi
    for ad in $ADS; do
      say "Trying $shape in $ad"
      args=(--compartment-id "$COMPARTMENT" --availability-domain "$ad" --shape "$shape"
            --image-id "$image" --subnet-id "$SUBNET" --assign-public-ip true --display-name "$VM_NAME"
            --ssh-authorized-keys-file "$KEY.pub" --user-data-file "$USER_DATA"
            --wait-for-state RUNNING --max-wait-seconds 900)
      [ -n "$config" ] && args+=(--shape-config "$config")
      if oci_ compute instance launch "${args[@]}" >"$OUT" 2>"$ERR"; then
        INSTANCE=$(jq -r '.data.id' "$OUT")
        return 0
      fi
      if grep -qi "out of host capacity" "$ERR"; then
        echo "   no free capacity here, trying the next one"
      elif grep -qiE "LimitExceeded|QuotaExceeded|limit" "$ERR"; then
        echo "   limit reached for $shape: $(grep -oiE '"message": *"[^"]*"' "$ERR" | head -1)"
      else
        echo "   failed: $(grep -oiE '"message": *"[^"]*"' "$ERR" | head -1)"
        tail -n 5 "$ERR"
      fi
    done
    return 1
  }

  try_launch VM.Standard.A1.Flex '{"ocpus":1,"memoryInGBs":6}' \
    || try_launch VM.Standard.E2.1.Micro "" \
    || fail "No Always Free capacity right now (A1.Flex and E2.1.Micro). Wait some minutes and run this script again."
  rm -f "$ERR" "$OUT"
fi

# --- Result --------------------------------------------------------------------
IP=$(oci_ compute instance list-vnics --instance-id "$INSTANCE" | jq -r '(.data // [])[0]."public-ip" // empty')
[ -n "$IP" ] || fail "VM is running but has no public IP."
SHAPE=$(oci_ compute instance get --instance-id "$INSTANCE" | jq -r '.data.shape')

cat <<EOF

================================================================
 Echo VM is RUNNING  ($SHAPE)
 Public IP : $IP
 SSH       : ssh -i ~/.ssh/echo_vm ubuntu@$IP
 HTTPS host: echo-${IP//./-}.sslip.io
================================================================
 First boot setup (Docker, firewall) takes 3-5 minutes.
EOF
