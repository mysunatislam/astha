# Presenting ASTHA with the ClipCam

Use the **ASTHA ClipCam** shortcut prepared on this laptop. It opens the same Chrome
profile in which the kit was paired; another browser or a private/incognito window does
not have that pairing.

1. Power the Pi and join the Pi and laptop to the same phone hotspot. Keep the hotspot
   name/password unchanged for this demo. The Pi camera service starts automatically.
2. Open **ASTHA ClipCam**. Wait for **Your ASTHA ClipCam is connected**. The saved code is
   used privately; you do not type it again. If automatic reconnection was disabled, open
   **Devices → Your ASTHA ClipCam → Connect camera**.
3. Choose **Allow for this session** if you want online descriptions. This consent is
   separate from camera pairing. No provider API key is required.
4. In Detailed view, look at **Paired Wi-Fi camera · Current view**. Moving the camera
   changes this live picture. The detector's boxes/scores are separate from the online AI.
5. Choose **Describe this view in detail** under the picture. The **Picture description**
   card shows the actual returned answer, its capture time and whether the online AI or
   the local detector answered. It describes that captured picture; ask again after the
   scene changes. Online responses can take several seconds or longer.
6. **Run one check** runs the local detector. Zero boxes means the detector did not identify
   objects in that frame; it does not prove the scene is empty. A missing ultrasonic echo
   is displayed as an unknown distance.

If the kit is unavailable, check power and the shared hotspot first. ASTHA cannot reach a
Pi left on another Wi-Fi network. The stable address for this kit is entered during private
setup; the app remembers the kit's identity rather than treating an IP as its identity.
If this browser profile is cleared, or you choose **Forget**, one new private pairing is
needed. The desktop shortcut contains no password or pairing code.

The public page also opens at `https://astha-preview.onrender.com/#detailed-view`; use the
prepared shortcut on this laptop to retain its saved pairing. On a different laptop or
phone, initial pairing and certificate/browser permissions must be completed there.
Free Render hosting can need time to wake after being idle. Open it before the judges arrive.
