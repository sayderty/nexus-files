@echo off
chcp 65001 >nul
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  echo Запрашиваю права администратора для сборки...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
set CSC_IDENTITY_AUTO_DISCOVERY=false
rem GitHub у вас недоступен (getaddrinfow / hostname resolution) - качаем инструменты сборки с зеркала
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
echo === Очистка сломанного кэша сборщика ===
if exist "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign" rmdir /s /q "%LOCALAPPDATA%\electron-builder\Cache\winCodeSign"
echo === Установка зависимостей ===
call npm install
if errorlevel 1 goto err
echo === Сборка лаунчера ===
call npm run build
if not errorlevel 1 goto done
echo.
echo === Повторная сборка без вшивания иконки в .exe (не нужен winCodeSign) ===
call npx electron-builder --win nsis portable --publish never -c.win.signAndEditExecutable=false
if errorlevel 1 goto err
:done
echo.
echo ГОТОВО. Файлы в папке dist:
echo   NexusLauncher-Setup.exe  - установщик (ярлык с логотипом на рабочем столе)
echo   NexusLauncher.exe        - портативная версия
start "" "%~dp0dist"
pause
exit /b 0
:err
echo.
echo ОШИБКА СБОРКИ. Скопируйте текст выше и пришлите мне.
pause
exit /b 1
