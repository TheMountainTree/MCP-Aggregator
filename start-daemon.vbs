Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "F:\reposity\mcp"
WshShell.Run "node gateway.js", 0, False
