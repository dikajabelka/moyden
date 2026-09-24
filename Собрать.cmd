@echo off
chcp 65001 >nul
setlocal
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
cd /d "%~dp0"
set "PY=_python\python.exe"
if exist "%PY%" goto run

echo.
echo  Первый запуск: скачиваю всё нужное (около 1-2 минут, нужен интернет).
echo  Потом это не понадобится.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $v='3.12.10'; New-Item -ItemType Directory -Force '_python' | Out-Null; Invoke-WebRequest ('https://www.python.org/ftp/python/'+$v+'/python-'+$v+'-embed-amd64.zip') -OutFile '_python\py.zip' -UseBasicParsing; Expand-Archive '_python\py.zip' -DestinationPath '_python' -Force; Remove-Item '_python\py.zip'; $p=(Get-ChildItem '_python\python*._pth' | Select-Object -First 1).FullName; (Get-Content $p) -replace '^#\s*import site','import site' | Set-Content $p; Invoke-WebRequest 'https://bootstrap.pypa.io/get-pip.py' -OutFile '_python\get-pip.py' -UseBasicParsing"
if errorlevel 1 goto fail
"%PY%" _python\get-pip.py -q --no-warn-script-location
if errorlevel 1 goto fail
"%PY%" -m pip install -q --no-warn-script-location pillow
if errorlevel 1 goto fail
echo  Готово, дальше всё будет запускаться сразу.
echo.

:run
"%PY%" build.py
echo.
pause
exit /b

:fail
echo.
echo  Не получилось скачать. Проверьте интернет и запустите ещё раз.
echo  Если снова не выйдет - пришлите фото этого окна в чат.
rmdir /s /q _python 2>nul
pause
