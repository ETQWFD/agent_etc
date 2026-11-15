; agent_etc NSIS 安装脚本（在 Linux 上用原生 makensis 编译，不经过 wine）
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APP_NAME "agent_etc"
!define APP_VERSION "1.3.0"
!define APP_PUBLISHER "ETC"
!define APP_EXE "agent_etc.exe"
!define APP_ID "agent_etc"

Name "${APP_NAME}"
OutFile "dist/agent_etc-1.3.0-x64.exe"
InstallDir "$LOCALAPPDATA\Programs\agent_etc"
InstallDirRegKey HKCU "Software\agent_etc" "InstallDir"
RequestExecutionLevel user
BrandingText "agent_etc · ETC"

VIProductVersion "1.3.0.0"
VIAddVersionKey /LANG=2052 "ProductName" "agent_etc"
VIAddVersionKey /LANG=2052 "ProductVersion" "1.3.0"
VIAddVersionKey /LANG=2052 "FileDescription" "agent_etc 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "1.3.0.0"
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
  SetOutPath "$INSTDIR"
  File /r "dist/win-unpacked/*"

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
