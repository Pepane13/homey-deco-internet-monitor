Deco & Internet Monitor watches your home network locally, without any cloud service, and turns it into Homey devices, Insights charts and Flow triggers.

Internet quality: connectivity probes every 30 s towards several Internet targets (latency, jitter, packet loss), local latency to the box, DNS resolution time, and periodic speed tests (download, upload, latency), run by the Livebox itself at full line speed or from Homey. Confirmed outages are counted with their duration, and alerts are raised when a threshold is crossed several times in a row.

Internet box, choose your provider before pairing: Orange and Sosh (Livebox 4, 5, 6, 7), Bouygues Telecom (Bbox) and SFR (SFR Box). Internet link state, public IP address, connection and box uptime; real-time Internet traffic on Livebox and Bbox; optical power and native speed test on Livebox. Flows for link loss, reconnection, box reboot, IP change and weak fibre signal.

TP-Link Deco: one device per node, online state, connected clients (per node and per band on the main Deco), CPU and memory load, wireless backhaul signal and speed. Flows when a node goes offline, when the backhaul weakens, and when a device connects or disconnects.

Requirements: Homey Pro. Livebox administration password. Deco owner account password (the Deco refuses manager accounts; each login closes the owner session of the Deco app, so use a manager account in the app). Speed tests run from Homey Pro (Early 2023) cannot exceed about 94 Mbit/s (100 Mbit/s Ethernet port); the Livebox test has no such limit.
