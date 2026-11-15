; agent_etc NSIS 安装脚本（在 Linux 上用原生 makensis 编译，不经过 wine）
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP_NAME "agent_etc"
!define APP_VERSION "1.5.1"
!define APP_PUBLISHER "ETC"
!define APP_EXE "agent_etc.exe"
!define APP_ID "agent_etc"

Name "${APP_NAME}"
OutFile "dist/agent_etc-1.5.1-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\agent_etc"
InstallDirRegKey HKCU "Software\agent_etc" "InstallDir"
RequestExecutionLevel highest
BrandingText "agent_etc · ETC"

VIProductVersion "1.5.1.0"
VIAddVersionKey /LANG=2052 "ProductName" "agent_etc"
VIAddVersionKey /LANG=2052 "ProductVersion" "1.5.1"
VIAddVersionKey /LANG=2052 "FileDescription" "agent_etc 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "1.5.1.0"
VIAddVersionKey /LANG=2052 "CompanyName" "ETC"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Copyright © 2026 ETC"

!define MUI_ICON "build/icon.ico"
!define MUI_UNICON "build/icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "立即启动 agent_etc"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"

Section "Install"
  ; 安装到新目录/覆盖升级时，先结束旧实例；否则 Windows 会锁定 exe 和 app.asar，
  ; 导致文件只复制了一半，启动后白屏或完全点不动。
  nsExec::Exec 'taskkill /F /IM agent_etc.exe'
  Sleep 600
  SetOverwrite on
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*"

  IfFileExists "$INSTDIR\${APP_EXE}" install_exe_ok
    MessageBox MB_ICONSTOP|MB_OK "安装失败：主程序没有写入 $INSTDIR。请换一个有写入权限的目录，或先关闭正在运行的 agent_etc 再重试。"
    Abort
  install_exe_ok:
  IfFileExists "$INSTDIR\resources\app.asar" install_asar_ok
    MessageBox MB_ICONSTOP|MB_OK "安装失败：resources\app.asar 没有写入 $INSTDIR。安装目录不完整，请重新安装。"
    Abort
  install_asar_ok:

  WriteUninstaller "$INSTDIR\Uninstall ${APP_NAME}.exe"

  WriteRegStr HKCU "Software\agent_etc" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "UninstallString" "$\"$INSTDIR\Uninstall ${APP_NAME}.exe$\""
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}" "NoRepair" 1

  CreateDirectory "$SMPROGRAMS\agent_etc"
  CreateShortcut "$SMPROGRAMS\agent_etc\agent_etc.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\agent_etc\卸载 agent_etc.lnk" "$INSTDIR\Uninstall ${APP_NAME}.exe"
  CreateShortcut "$DESKTOP\agent_etc.lnk" "$INSTDIR\${APP_EXE}"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\agent_etc.lnk"
  Delete "$SMPROGRAMS\agent_etc\agent_etc.lnk"
  Delete "$SMPROGRAMS\agent_etc\卸载 agent_etc.lnk"
  RMDir "$SMPROGRAMS\agent_etc"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_ID}"
  DeleteRegKey HKCU "Software\agent_etc"

  RMDir /r "$INSTDIR"
SectionEnd
