# Storage Smart Entry — Pi Bridge

Local BLE bridge that unlocks Noke locks on behalf of the cloud backend.

```
[PWA] → [Railway] → [WebSocket] → [Pi @ facility] → [BLE] → [Lock]
```

The Pi maintains a persistent WebSocket connection to the cloud backend.
When a tenant taps "unlock," the backend sends an unlock command to the Pi
(with the MAC + cached offlineKey from your Supabase). The Pi does the AES
handshake over BLE and reports back. Noke's cloud is not in the loop.

---

## Prerequisites — flashing the Pi

1. Insert microSD card into a card reader plugged into your PC.
2. Download **Raspberry Pi Imager** from https://raspberrypi.com/software
3. Run it:
   - Device:        Raspberry Pi 4
   - OS:            Raspberry Pi OS Lite (64-bit) — no desktop, headless
   - Storage:       your microSD card
4. Click the gear icon (⚙) for advanced options:
   - Set hostname:           `pi-bridge`
   - Enable SSH:             yes (use password auth)
   - Set username:           `pi`
   - Set password:           something memorable
   - Configure WiFi:         your facility's WiFi name + password
   - Set locale:             your timezone
5. Write the SD card. Eject when done.
6. Insert SD into the Pi, plug power. First boot takes ~3 minutes.

---

## Find the Pi on your network

After boot:
- From any computer on the same WiFi, run: `ping pi-bridge.local`
- If that works, SSH in: `ssh pi@pi-bridge.local`
- Otherwise, check your router's DHCP table for "pi-bridge"

---

## Install dependencies on the Pi

```bash
# SSH in
ssh pi@pi-bridge.local

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential libudev-dev

# Allow Node.js to access BLE without sudo
sudo setcap cap_net_raw+eip $(eval readlink -f `which node`)

# Clone this project
git clone https://github.com/YOUR_USERNAME/storage-pi-bridge.git
cd storage-pi-bridge
npm install
```

---

## Configure

```bash
cp .env.example .env
nano .env
```

Set:
- `BRIDGE_TOKEN` — match the value in your Railway env vars
- `BACKEND_WS_URL` — your Railway backend's WebSocket URL
- `BRIDGE_ID` — any friendly name

---

## Run

### Manual run (for testing)

```bash
npm run dev
```

You should see logs like:
```
[ble] adapter state: poweredOn
[ws] connecting to wss://storage-backend-production-cbfe.up.railway.app/bridge...
[ws] connected
```

### Manual unlock test (no cloud needed)

If you're near a lock and have its key, you can validate BLE works
end-to-end without the cloud:

```bash
npm run test:unlock -- F3:25:19:08:73:38 6b481fdfcd6c7c215fa8a54f439f63a7 0001e4008a6cc77f1c4544236fd9a69ec2e18503
```

### Run as a systemd service (production)

Once you've confirmed it works manually, set it up to auto-start on boot:

```bash
sudo nano /etc/systemd/system/pi-bridge.service
```

Paste:
```
[Unit]
Description=Storage Smart Entry Pi Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/storage-pi-bridge
ExecStart=/usr/bin/node /home/pi/storage-pi-bridge/dist/index.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Build & enable:
```bash
npm run build
sudo systemctl daemon-reload
sudo systemctl enable pi-bridge
sudo systemctl start pi-bridge
sudo systemctl status pi-bridge   # confirm it's running
journalctl -u pi-bridge -f         # tail logs
```

---

## How the BLE protocol works (for reference)

Each Noke lock advertises a single BLE service:
- **Service UUID:** `1bc50001-0200-d29e-e511-446c609db825`
- TX char (write):    `1bc50002-...`
- RX char (notify):   `1bc50003-...`
- Session char (read):`1bc50004-...`

Unlock flow:
1. Scan for the device with the matching MAC.
2. Connect, discover service + characteristics.
3. Read 20 bytes from the session characteristic.
4. Compute the AES-mixed key:  `combined[i] = offlineKey[i] XOR session[i+4]`
5. Encrypt the unlock payload (last 16 bytes of `offlineUnlockCmd`) with `combined`.
6. Concatenate header + encrypted = 20-byte unlock command.
7. Recompute checksum (last byte = sum of bytes 0-18 mod 256).
8. Write to TX. Wait for response on RX. Lock pops open.
