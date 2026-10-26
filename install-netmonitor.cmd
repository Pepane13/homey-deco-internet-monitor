@echo off
rem Installs the Deco and Internet Monitor app on your Homey Pro (development install).
rem Double-click, or run from any terminal. Uses homey.cmd, so the PowerShell
rem execution policy does not get in the way.
setlocal
chcp 65001 >nul
cd /d "%~dp0com.pepane13.netmonitor" || (echo [ERREUR] Dossier com.pepane13.netmonitor introuvable a cote du script. & goto :end)

where node >nul 2>&1 || (echo [ERREUR] Node.js n'est pas installe : https://nodejs.org & goto :end)
where homey.cmd >nul 2>&1 || (
  echo Homey CLI absent, installation...
  call npm install -g homey || (echo [ERREUR] Installation du Homey CLI impossible. & goto :end)
)

echo.
echo === Compte Homey ===
call homey.cmd whoami >nul 2>&1 || call homey.cmd login || (echo [ERREUR] Connexion au compte Homey refusee. & goto :end)

echo.
echo === Validation de l'app ===
call homey.cmd app validate --level publish || (echo [ERREUR] Validation echouee, installation annulee. & goto :end)

echo.
echo === Installation sur la Homey ===
set "LOG=%TEMP%\netmonitor-install.log"
call homey.cmd app install > "%LOG%" 2>&1
type "%LOG%"
rem The Homey CLI exits with code 0 even when the installation fails: check its output.
findstr /C:"successfully installed" "%LOG%" >nul || (
  echo.
  echo [ERREUR] Installation echouee sur la Homey.
  findstr /C:"homeypro.net" "%LOG%" >nul && (
    echo La Homey a ete jointe par le cloud et non par le reseau local.
    echo Connecte ce PC au meme reseau que la Homey, sans VPN, puis relance le script.
  )
  goto :end
)

echo.
echo [OK] Deco and Internet Monitor installee.

:end
echo.
pause
endlocal
