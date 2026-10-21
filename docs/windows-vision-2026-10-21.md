# Windows native vision acceptance

The check runs only on a dedicated GitHub Windows desktop. It refuses an occupied developer desktop; no local global-input test, package publication, npm release or tag was performed.

## Reproduced failures and repairs

- Strict coordinate scroll returned `coordinate_blocked` after already activating the target. Check delivery policy before activation / physical-input bookkeeping. The regression uses an invalid HWND so the policy error must win.
- Native WinForms Invoke and ValuePattern writes activated their window under `ax_only`. ElementHost WPF Invoke, standalone Framework WPF Invoke / Toggle and ListView ScrollPattern also activated their target in subsequent real runs. Preserve the failures rather than treating AX delivery as proof of background execution.
- Refuse known activating press providers before input. Check the resolved leaf as well as the observation root: WPF's WindowsFormsHost can contain a legacy WinForms button. A real mixed-host negative control verifies this boundary.
- For a verified WinForms EDIT HWND, use bounded WM_SETTEXT with UIA / style readonly checks and the actual HWND parent chain's disabled state. Do not send synthetic button notifications that bypass application validation.
- For a verified report-mode native ListView, use pointer-free LVM_GETCOUNTPERPAGE and LVM_SCROLL messages, with enabled-parent checks and explicit zero-axis handling. Unmeasured activating scroll providers require foreground permission. Message definitions: [Microsoft LVM_SCROLL](https://learn.microsoft.com/en-us/windows/win32/controls/lvm-scroll), [LVM_GETCOUNTPERPAGE](https://learn.microsoft.com/en-us/windows/win32/controls/lvm-getcountperpage).
- Native writes that time out, lose acknowledgement/readback, or are normalized by the application retain uncertain delivery. Do not label them undelivered and retry in the foreground. The real fixture includes a slow TextChanged handler and a normalizer that counts writes.

## Evidence

[Windows run 39607323188](https://github.com/Changan-Su/Tangu-Computer-Use/actions/runs/39607323188) passed npm ci / build / check, 126 native Rust tests, release-helper build and all 37 explicit native checks. Actual coordinates scroll a native list and drag a line on its canvas; image sizes are decoded from the screenshot bytes; the absent expect text is reported after delivered input. Settings survive config reload; browser tools and visualization switches are exercised. The cover stays foreground for safe text / reference scrolling and rejected actions. Disabling strict mode restores foreground routing.

The final focused GPT-6.1 Sol xhigh review found one remaining mixed-host P2. The resolved leaf guard and its real WindowsFormsHost negative control repair it; final-head CI is pending. Earlier review findings about owner-drawn buttons, disabled ancestors and timed-out click replay were repaired by refusing unsafe invocation, checking real ancestors and preserving text uncertainty.

Fixture prerequisites are explicit: visible native windows, real focused list and foreground authorization on the owned runner. WPF descendants folded from compact outlines are resolved through real search_ui references. No fabricated native refs, forced local foreground, weakened cover assertions or retries of failed checks are used.

This validates source and built helper behavior on Windows Server 2022. The currently published npm package remains unchanged; a normal approved release is required to deliver the helper to installed clients.
