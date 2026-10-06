@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo No se encuentra Electron. Instala las dependencias ejecutando:
  echo   npm install
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo No se encuentran las dependencias del gestor. Instala las dependencias ejecutando:
  echo   npm install
  echo.
  pause
  exit /b 1
)

call npm start
if errorlevel 1 (
  echo No se pudo iniciar el gestor.
  pause
  exit /b 1
)

endlocal
exit /b 0
