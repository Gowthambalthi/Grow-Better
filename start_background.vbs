' Grow-Better Silent Background Launcher
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "c:\Users\goutham\openalgo"
WshShell.Run "cmd /c set GB_TICK_CAPTURE=1&& set GB03_SIDES=short&& set GB_OF_MOMENTUM_LIVE=0&& set PORT=4000&& node Server.js > logs\server.log 2>&1", 0, False
