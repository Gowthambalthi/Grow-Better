Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "cmd /c cd /d ""c:\Users\goutham\openalgo\broker"" && node Server.js", 0, False
