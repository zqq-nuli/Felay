; Felay NSIS Installer Hooks
; Called by Tauri's NSIS installer at various lifecycle stages.
; Uses direct registry manipulation (no external plugins required).

!macro NSIS_HOOK_POSTINSTALL
  ; Read current user PATH from registry
  ReadRegStr $0 HKCU "Environment" "Path"
  StrCmp $0 "" _felay_path_empty _felay_path_exists
_felay_path_empty:
  WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
  Goto _felay_path_done
_felay_path_exists:
  WriteRegExpandStr HKCU "Environment" "Path" "$0;$INSTDIR"
_felay_path_done:
  ; Notify the system that environment variables have changed
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Kill any running daemon process before uninstalling
  nsExec::Exec 'taskkill /F /IM felay-daemon.exe'
  Pop $0

  ; Remove install directory from user PATH using a temp PowerShell script
  FileOpen $1 "$TEMP\felay-uninstall-path.ps1" w
  FileWrite $1 "$$instDir = '$INSTDIR'$\r$\n"
  FileWrite $1 "$$p = [Environment]::GetEnvironmentVariable('Path', 'User')$\r$\n"
  FileWrite $1 "if ($$p) {$\r$\n"
  FileWrite $1 "  $$parts = $$p -split ';' | Where-Object { $$_ -ne $$instDir }$\r$\n"
  FileWrite $1 "  [Environment]::SetEnvironmentVariable('Path', ($$parts -join ';'), 'User')$\r$\n"
  FileWrite $1 "}$\r$\n"
  FileClose $1

  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$TEMP\felay-uninstall-path.ps1"'
  Pop $0
  Delete "$TEMP\felay-uninstall-path.ps1"

  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000

  ; NOTE: Do NOT delete $PROFILE\.felay here.
  ; The NSIS preuninstall hook runs during upgrades as well.
  ; Deleting it would wipe user config (bots, master-key) on every update.
!macroend
