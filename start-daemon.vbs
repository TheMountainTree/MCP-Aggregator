' Start the gateway silently in background (recommended for auto-start).
' The working directory is resolved from this script's own location,
' so it works no matter where the repo is cloned.
Set fso = CreateObject("Scripting.FileSystemObject")
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "node gateway.js", 0, False
