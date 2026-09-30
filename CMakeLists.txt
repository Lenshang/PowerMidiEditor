cmake_minimum_required(VERSION 3.24)

project(PowerMidiEditor VERSION 0.2.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Sources contain UTF-8 Chinese text without BOM; keep MSVC off the legacy
# codepage (also silences the C4819 warnings).
if(MSVC)
    add_compile_options(/utf-8)
endif()

option(PME_DEV_MODE "Load the editor UI from the Vite dev server (http://localhost:5173) instead of embedded assets" OFF)
option(PME_BUILD_TESTS "Build the automated test apps (PmeTests, PmeHost)" ON)

# ---------------------------------------------------------------------------
# JUCE (local copy)
# ---------------------------------------------------------------------------
add_subdirectory(JUCE)

# ---------------------------------------------------------------------------
# WebView2 SDK: JUCE's FindWebView2.cmake only accepts a NuGet *PackageManagement*
# layout (`<dir>/*Microsoft.Web.WebView2*/build/native/...`). The global NuGet
# cache stores bare version subfolders that never match its glob, so mirror the
# package into a correctly-named shim folder and point JUCE at it.
# ---------------------------------------------------------------------------
set(_PME_WV2_CACHE "$ENV{USERPROFILE}/.nuget/packages/microsoft.web.webview2")
set(_PME_WV2_SHIM_PARENT "${CMAKE_BINARY_DIR}/webview2_shim")
set(_PME_WV2_SHIM "${_PME_WV2_SHIM_PARENT}/Microsoft.Web.WebView2")

if(EXISTS "${_PME_WV2_CACHE}" AND NOT EXISTS "${_PME_WV2_SHIM}/build/native/include/WebView2.h")
    file(GLOB _PME_WV2_VERSIONS "${_PME_WV2_CACHE}/*")
    list(SORT _PME_WV2_VERSIONS)
    list(LENGTH _PME_WV2_VERSIONS _PME_WV2_COUNT)
    if(_PME_WV2_COUNT GREATER 0)
        list(GET _PME_WV2_VERSIONS -1 _PME_WV2_LATEST)
        file(COPY "${_PME_WV2_LATEST}/build" DESTINATION "${_PME_WV2_SHIM}")
        message(STATUS "PME: mirrored WebView2 SDK ${_PME_WV2_LATEST} -> ${_PME_WV2_SHIM}")
    endif()
endif()

if(EXISTS "${_PME_WV2_SHIM}/build/native/include/WebView2.h")
    set(JUCE_WEBVIEW2_PACKAGE_LOCATION "${_PME_WV2_SHIM_PARENT}" CACHE PATH
        "Directory containing the Microsoft.Web.WebView2 package folder" FORCE)
endif()

# ---------------------------------------------------------------------------
# Frontend assets: embedded as a single zip (frontend/dist/assets.zip).
# Build the frontend first:  scripts/build.ps1  (or frontend: npm run package)
# A placeholder zip is written so CMake can configure before the first
# frontend build; the real zip replaces it and binary data rebuilds on change.
# ---------------------------------------------------------------------------
set(PME_FRONTEND_ZIP "${CMAKE_CURRENT_SOURCE_DIR}/frontend/dist/assets.zip")
if(NOT EXISTS "${PME_FRONTEND_ZIP}")
    file(WRITE "${PME_FRONTEND_ZIP}" "")
    message(STATUS "PME: frontend zip missing, wrote placeholder (build the frontend for embedded UI)")
endif()

juce_add_binary_data(PMEAssets NAMESPACE PmeAssets SOURCES "${PME_FRONTEND_ZIP}")

# ---------------------------------------------------------------------------
# Plugin: PowerMidiEditor — MIDI-only VST3 (MIDI in/out, no audio buses) so it
# lands in Bitwig's Note FX slot and Cubase MIDI inserts.
# ---------------------------------------------------------------------------
# macOS builds get AU (Windows has no AU); CLAP is added separately below.
if(APPLE)
    set(PME_PLUGIN_FORMATS VST3 AU Standalone)
else()
    set(PME_PLUGIN_FORMATS VST3 Standalone)
endif()

juce_add_plugin(PowerMidiEditor
    PRODUCT_NAME "PowerMidiEditor"
    COMPANY_NAME "PowerMidiEditor"
    BUNDLE_ID "com.powermidi.editor"
    PLUGIN_MANUFACTURER_CODE Pwra
    PLUGIN_CODE Pmed
    FORMATS ${PME_PLUGIN_FORMATS}
    IS_SYNTH FALSE
    IS_MIDI_EFFECT TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    NEEDS_WEB_BROWSER TRUE
    NEEDS_WEBVIEW2 TRUE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_AUTO_MANIFEST TRUE
    # Per-format categories: the CLAP build declares "note-effect" (Bitwig
    # lists it under Note FX), while the VST3 declares Instrument — the user's
    # preferred classification for hosts that read VST3 subcategories.
    VST3_CATEGORIES Instrument)

# CLAP build (clap-juce-extensions): Bitwig co-created CLAP and gives it
# first-class raw MIDI output — the workaround for Bitwig's broken handling of
# VST3 legacy MIDI CC/pitch-bend events from plugins.
# "note-effect" is the tag Bitwig uses to list the plugin under Note FX.
add_subdirectory(libs/clap-juce-extensions EXCLUDE_FROM_ALL)
clap_juce_extensions_plugin(TARGET PowerMidiEditor
    CLAP_ID "com.powermidi.editor"
    CLAP_FEATURES note-effect utility
    CLAP_MISBEHAVIOUR_HANDLER_LEVEL "Ignore"
    CLAP_CHECKING_LEVEL "Minimal"
    CLAP_PROCESS_EVENTS_RESOLUTION_SAMPLES 0
    CLAP_USE_JUCE_PARAMETER_RANGES OFF)

target_sources(PowerMidiEditor PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginEditor.cpp
    Source/Bridge/UiBridge.cpp
    Source/Model/MidiClipDocument.cpp
    Source/Model/ChordAnalyzer.cpp
    Source/Playback/PlaybackEngine.cpp
    Source/FileIO/MidiFileIO.cpp
    Source/FileIO/ExpressionMapIO.cpp
    Source/FileIO/DrumMapIO.cpp)

target_include_directories(PowerMidiEditor PRIVATE
    "${CMAKE_BINARY_DIR}/juce_binarydata_PMEAssets/JuceLibraryCode")

target_compile_definitions(PowerMidiEditor PUBLIC
    JUCE_WEB_BROWSER=1
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_USE_WIN_WEBVIEW2_WITH_STATIC_LINKING=1
    JUCE_MODAL_LOOPS_PERMITTED=0
    PME_MIDI_ONLY=1
    $<$<BOOL:${PME_DEV_MODE}>:PME_DEV_SERVER_URL="http://localhost:5173/">)

target_link_libraries(PowerMidiEditor
    PRIVATE
        PMEAssets
        juce::juce_audio_utils
        juce::juce_gui_extra
    PUBLIC
        juce::juce_recommended_config_flags
        juce::juce_recommended_lto_flags
        juce::juce_recommended_warning_flags)

# ---------------------------------------------------------------------------
# Automated tests
#   PmeTests — pure engine/document unit tests (no plugin loading)
#   PmeHost  — loads the built VST3 like a host would: fake transport, checks
#              scheduled MIDI output + pass-through, opens the editor and waits
#              for the WebView bridge (see scripts/test.ps1)
# ---------------------------------------------------------------------------
if(PME_BUILD_TESTS)
    juce_add_console_app(PmeTests PRODUCT_NAME "PmeTests")
    target_sources(PmeTests PRIVATE
        Tests/PmeTests.cpp
        Source/Model/MidiClipDocument.cpp
        Source/Model/ChordAnalyzer.cpp
        Source/Playback/PlaybackEngine.cpp
        Source/FileIO/MidiFileIO.cpp
        Source/FileIO/ExpressionMapIO.cpp
        Source/FileIO/DrumMapIO.cpp)
    target_compile_definitions(PmeTests PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0)
    target_link_libraries(PmeTests PRIVATE
        juce::juce_audio_basics
        juce::juce_core
        juce::juce_recommended_config_flags)

    juce_add_console_app(PmeHost PRODUCT_NAME "PmeHost")
    target_sources(PmeHost PRIVATE Tests/PmeHost.cpp)
    target_compile_definitions(PmeHost PRIVATE
        JUCE_WEB_BROWSER=0
        JUCE_USE_CURL=0
        JUCE_PLUGINHOST_VST3=1
        JUCE_MODAL_LOOPS_PERMITTED=1)
    target_link_libraries(PmeHost PRIVATE
        juce::juce_audio_utils
        juce::juce_audio_processors
        juce::juce_recommended_config_flags)

    # PmeHostClap — loads the built .clap like a DAW and classifies every wire
    # event: proves pitch bend leaves the plugin as raw MIDI, never as notes.
    # Uses LoadLibrary to load the .clap, so Windows only.
    if(WIN32)
        add_executable(PmeHostClap Tests/PmeHostClap.cpp)
        target_include_directories(PmeHostClap PRIVATE
            ${CMAKE_CURRENT_SOURCE_DIR}/libs/clap-juce-extensions/clap-libs/clap/include)
        target_compile_definitions(PmeHostClap PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    endif()
endif()
