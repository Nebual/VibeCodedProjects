' Zero-flash launcher for Enable-TvGamingMode.ps1.
'
' -WindowStyle Hidden still flashes a console: the host is created and only
' then hidden. WScript.Shell.Run with intWindowStyle 0 genuinely never shows
' one. -ExecutionPolicy Bypass is required -- ExecutionPolicy is Undefined at
' every scope on this machine, so the script would not run otherwise.
Option Explicit
Dim shell, fso, here, ps
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\Enable-TvGamingMode.ps1"" -Quiet"
shell.Run ps, 0, False
