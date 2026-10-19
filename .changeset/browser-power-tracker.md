---
'@bugsee/browser': minor
'@bugsee/webview': minor
---

Browser and WebView system traces gain `battery_charging_time_s` and `battery_discharging_time_s` (integer seconds, from the Battery Status API's `chargingTime` / `dischargingTime`; omitted whenever the browser reports no finite estimate). The battery source is now a per-window singleton `PowerTracker` that listens to all four Battery Status events and keeps the resolved battery manager across the last unsubscribe, so a later subscription does not call `getBattery()` again. `battery` and `charging` are unchanged.
