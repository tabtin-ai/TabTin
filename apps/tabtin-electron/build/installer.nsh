; TabTin NSIS uninstall hooks — keep path names in sync with
; packages/tabtin-shared/src/uninstall-cleanup-paths.ts
;
; Policy:
;   - Never wipe on upgrade ($isUpdated)
;   - Always delete credentials.json under every known userData profile
;   - Optional wipe = config + cache ONLY
;   - NEVER delete organizations/ (workspace project files) or bound working_dir

!include "FileFunc.nsh"
!insertmacro GetParameters
!insertmacro GetOptions

; Windows merges the current user's Desktop with the public Desktop. When an
; older per-user TabTin is replaced by an all-users install, its shortcut can
; remain visible beside the new public shortcut. Keep electron-builder's
; shortcut ($newDesktopLink) and remove the current user's duplicate.
;
; Do not perform the inverse cleanup for a per-user install: deleting the
; public shortcut would hide the machine-wide app from every other user.
!macro removeDuplicateTabTinDesktopShortcut
  ${If} $installMode == "all"
    Push $0
    StrCpy $0 "$newDesktopLink"

    SetShellVarContext current
    StrCmp "$DESKTOP\${SHORTCUT_NAME}.lnk" "$0" tabtinKeepCurrentDesktopShortcut
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    tabtinKeepCurrentDesktopShortcut:

    ; Do not leak the temporary lookup context into later installer hooks.
    SetShellVarContext all
    Pop $0
  ${EndIf}
!macroend

; Older per-user installs placed the Start Menu shortcut in the current user's
; profile. After switching to an all-users install, that stale shortcut can
; shadow the valid public shortcut and make Windows show a blank app icon.
!macro removeStaleTabTinStartMenuShortcut
  ${If} $installMode == "all"
    SetShellVarContext current
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"

    ; Keep later installer hooks on the all-users shell context.
    SetShellVarContext all
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro removeDuplicateTabTinDesktopShortcut
  !insertmacro removeStaleTabTinStartMenuShortcut
!macroend

!macro deleteTabTinCredentials
  Delete "$APPDATA\TabTin\credentials.json"
  Delete "$APPDATA\TabTin Dev\credentials.json"
  Delete "$APPDATA\TabTin Local\credentials.json"
  Delete "$APPDATA\TabTin Preprod\credentials.json"
  Delete "$APPDATA\tabtin-electron\credentials.json"
!macroend

; Wipe config/cache under one userData profile. Does NOT touch organizations\.
!macro wipeTabTinProfileConfig CACHE_ROOT
  Delete "${CACHE_ROOT}\credentials.json"
  Delete "${CACHE_ROOT}\device-credential.json"
  Delete "${CACHE_ROOT}\app-config.json"
  Delete "${CACHE_ROOT}\device-fingerprint.json"
  Delete "${CACHE_ROOT}\Preferences"
  Delete "${CACHE_ROOT}\Local State"
  Delete "${CACHE_ROOT}\Network Persistent State"
  Delete "${CACHE_ROOT}\TransportSecurity"
  Delete "${CACHE_ROOT}\Cookies"
  Delete "${CACHE_ROOT}\Cookies-journal"
  RMDir /r "${CACHE_ROOT}\mcp"
  RMDir /r "${CACHE_ROOT}\organization-configs"
  RMDir /r "${CACHE_ROOT}\logs"
  RMDir /r "${CACHE_ROOT}\Cache"
  RMDir /r "${CACHE_ROOT}\Code Cache"
  RMDir /r "${CACHE_ROOT}\GPUCache"
  RMDir /r "${CACHE_ROOT}\DawnGraphiteCache"
  RMDir /r "${CACHE_ROOT}\DawnWebGPUCache"
  RMDir /r "${CACHE_ROOT}\Partitions"
  RMDir /r "${CACHE_ROOT}\Local Storage"
  RMDir /r "${CACHE_ROOT}\Session Storage"
  RMDir /r "${CACHE_ROOT}\IndexedDB"
  RMDir /r "${CACHE_ROOT}\blob_storage"
  RMDir /r "${CACHE_ROOT}\Network"
  RMDir /r "${CACHE_ROOT}\agent-sync"
  RMDir /r "${CACHE_ROOT}\Service Worker"
  RMDir /r "${CACHE_ROOT}\WebStorage"
!macroend

!macro wipeTabTinLocalData
  !insertmacro wipeTabTinProfileConfig "$APPDATA\TabTin"
  !insertmacro wipeTabTinProfileConfig "$APPDATA\TabTin Dev"
  !insertmacro wipeTabTinProfileConfig "$APPDATA\TabTin Local"
  !insertmacro wipeTabTinProfileConfig "$APPDATA\TabTin Preprod"
  !insertmacro wipeTabTinProfileConfig "$APPDATA\tabtin-electron"
  ; ~/.tabtin：只删配置文件，保留 checkpoints / file-history / 用户相关内容
  Delete "$PROFILE\.tabtin\desktop-approval.json"
  Delete "$PROFILE\.tabtin\server.json"
  Delete "$PROFILE\.tabtin\cli.sock"
  RMDir /r "$PROFILE\.tabtin-daemon"
  RMDir /r "$LOCALAPPDATA\com.tabtin.app-updater"
  RMDir /r "$LOCALAPPDATA\com.tabtin.app.dev-updater"
  RMDir /r "$LOCALAPPDATA\com.tabtin.app.local-updater"
  RMDir /r "$LOCALAPPDATA\com.tabtin.app.preprod-updater"
  RMDir /r "$LOCALAPPDATA\TabTin-updater"
  RMDir /r "$LOCALAPPDATA\TabTin Dev-updater"
  RMDir /r "$LOCALAPPDATA\TabTin Local-updater"
  RMDir /r "$LOCALAPPDATA\TabTin Preprod-updater"
!macroend

!macro customUnInstall
  ${if} ${isUpdated}
    ; Keep login + local data across upgrades.
  ${else}
    !insertmacro deleteTabTinCredentials

    StrCpy $0 "0"
    ClearErrors
    ${GetParameters} $R0
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${IfNot} ${Errors}
      StrCpy $0 "1"
    ${Else}
      ${IfNot} ${Silent}
        MessageBox MB_YESNO|MB_ICONQUESTION \
          "Login credentials have been removed.$\r$\n$\r$\nAlso delete local TabTin config and cache?$\r$\n(Workspace folders and bound local directories are NEVER deleted.)$\r$\n$\r$\n登录凭证已清除。$\r$\n$\r$\n是否同时删除本地配置与缓存？$\r$\n（工作区目录与绑定的本机目录一律保留，不会删除。）" \
          IDYES tabtinFullWipe IDNO tabtinSkipFullWipe
        tabtinFullWipe:
          StrCpy $0 "1"
        tabtinSkipFullWipe:
      ${EndIf}
    ${EndIf}

    ${If} $0 == "1"
      !insertmacro wipeTabTinLocalData
    ${EndIf}
  ${endif}
!macroend
