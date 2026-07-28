' Zero-flash launcher for Disable-TvGamingMode.ps1.
'
' Bind this one to a physical button BEFORE the first real use. If the TV is
' dark, this is how you get your desk monitors back without being able to see
' anything.
Option Explicit
Dim shell, fso, here, ps
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & here & "\Disable-TvGamingMode.ps1"" -Quiet"
shell.Run ps, 0, False
