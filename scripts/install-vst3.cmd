@echo off
rem Install the PowerMidiEditor VST3 and CLAP to the system plugin folders.
rem Usage: scripts\install-vst3.cmd [Release^|Debug]  (default: Release)
rem Note: writing to the Common Files folders needs admin rights.

setlocal
set "CONFIG=%~1"
if "%CONFIG%"=="" set "CONFIG=Release"

set "ROOT=%~dp0.."
set "SRC_VST3=%ROOT%\build\PowerMidiEditor_artefacts\%CONFIG%\VST3\PowerMidiEditor.vst3"
set "SRC_CLAP=%ROOT%\build\PowerMidiEditor_artefacts\%CONFIG%\CLAP\PowerMidiEditor.clap"
set "DST_VST3=%COMMONPROGRAMFILES%\VST3"
set "DST_CLAP=%COMMONPROGRAMFILES%\CLAP"

if not exist "%SRC_VST3%" (
    echo [ERROR] VST3 not found:
    echo   %SRC_VST3%
    echo Build first:
    echo   powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Config %CONFIG%
    exit /b 1
)

echo Source: %SRC_VST3%
echo Target: %DST_VST3%\PowerMidiEditor.vst3
robocopy "%SRC_VST3%" "%DST_VST3%\PowerMidiEditor.vst3" /E /NFL /NDL /NJH /NJS >nul
if errorlevel 8 (
    echo [ERROR] VST3 copy failed. Run this window as administrator and try again.
    exit /b 1
)
echo [OK] Installed: %DST_VST3%\PowerMidiEditor.vst3

if exist "%SRC_CLAP%" (
    echo Source: %SRC_CLAP%
    echo Target: %DST_CLAP%\PowerMidiEditor.clap
    if not exist "%DST_CLAP%" mkdir "%DST_CLAP%"
    copy /Y "%SRC_CLAP%" "%DST_CLAP%\PowerMidiEditor.clap" >nul
    if errorlevel 1 (
        echo [ERROR] CLAP copy failed. Run this window as administrator and try again.
        exit /b 1
    )
    echo [OK] Installed: %DST_CLAP%\PowerMidiEditor.clap
) else (
    echo [WARN] CLAP not found, installed VST3 only:
    echo   %SRC_CLAP%
)

echo.
echo [NEXT] In Bitwig open Settings - Plug-ins - rescan, then load
echo        PowerMidiEditor in a track's Note FX slot.
echo        For working pitch bend / CC output to instruments use the
echo        CLAP version of the plugin (VST3 MIDI CC out is a Bitwig gap).
endlocal
