' Runs `node tools/edgeline-up.mjs --watchdog` with no window at all, for the
' "Edgeline watchdog" scheduled task (tools/install-edgeline-watchdog.ps1).
' A task pointed at node.exe or powershell.exe directly flashes a console
' every 15 minutes; WScript.Shell.Run with window style 0 does not.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = root
shell.Run "node """ & root & "\tools\edgeline-up.mjs"" --watchdog", 0, True
