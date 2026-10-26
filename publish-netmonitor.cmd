@echo off
rem Publishes the Deco and Internet Monitor app to the Homey App Store (test channel first).
rem Double-click, or run from any terminal. Uses homey.cmd, so the PowerShell
rem execution policy does not get in the way. The version number in app.json is
rem used as is: bump it (and .homeychangelog.json) before running this script.
setlocal
chcp 65001 >nul
cd /d "%~dp0com.pepane13.netmonitor" || (echo [ERREUR] Dossier com.pepane13.netmonitor introuvable a cote du script. & goto :end)

where node >nul 2>&1 || (echo [ERREUR] Node.js n'est pas installe : https://nodejs.org & goto :end)
where homey.cmd >nul 2>&1 || (
  echo Homey CLI absent, installation...
  call npm install -g homey || (echo [ERREUR] Installation du Homey CLI impossible. & goto :end)
)

for /f "delims=" %%v in ('node -p "require('./app.json').version"') do set "VER=%%v"
echo Publication de com.pepane13.netmonitor v%VER% sur le Homey App Store.

echo.
echo === Compte Homey ===
call homey.cmd whoami >nul 2>&1 || call homey.cmd login || (echo [ERREUR] Connexion au compte Homey refusee. & goto :end)

echo.
echo === Validation de l'app ===
call homey.cmd app validate --level publish || (echo [ERREUR] Validation echouee, publication annulee. & goto :end)

echo.
echo Regles du Homey App Store : https://apps.developer.homey.app/app-store/guidelines
choice /C ON /M "Publier la version %VER% (O = oui, N = non)"
if errorlevel 2 (echo Publication annulee. & goto :end)

echo.
echo === Publication ===
rem Headless mode: no prompts, the version number is kept, the changelog comes from .homeychangelog.json.
set "HOMEY_HEADLESS=1"
set "LOG=%TEMP%\netmonitor-publish.log"
call homey.cmd app publish > "%LOG%" 2>&1
type "%LOG%"
rem The Homey CLI exits with code 0 even when the upload fails: check its output.
findstr /C:"successfully uploaded" "%LOG%" >nul || (
  echo.
  echo [ERREUR] Publication echouee.
  findstr /C:"already been published" "%LOG%" >nul && echo La version %VER% est deja publiee ou en cours de revue : augmente la version dans package.json et .homeychangelog.json, puis regenere app.json.
  findstr /C:"Missing changelog" "%LOG%" >nul && echo Il manque l'entree %VER% dans .homeychangelog.json.
  goto :end
)

echo.
echo [OK] Version %VER% envoyee. Termine la publication sur :
echo https://tools.developer.homey.app/apps/app/com.pepane13.netmonitor

:end
echo.
pause
endlocal
