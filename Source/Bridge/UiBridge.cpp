#include "UiBridge.h"
#include "../FileIO/ExpressionMapIO.h"
#include "../FileIO/DrumMapIO.h"
#include "../FileIO/SelectionSnapshot.hpp"
#include "../Util/VarUtil.h"
#include "../FileIO/MidiFileIO.h"
#include <BinaryData.h>

namespace pme
{

namespace
{
//==============================================================================
// Browser restricted to our own resource provider (and the dev server in
// dev builds). Falls back to embedded assets if the dev server is down.
class SinglePageBrowser : public juce::WebBrowserComponent
{
public:
    SinglePageBrowser (const Options& o) : WebBrowserComponent (o) {}

    bool pageAboutToLoad (const juce::String& newURL) override
    {
        return newURL.startsWith (getResourceProviderRoot())
            || newURL == "about:blank"
#if defined (PME_DEV_SERVER_URL)
            || newURL.startsWith (PME_DEV_SERVER_URL)
#endif
            || newURL.startsWith ("data:");
    }

#if defined (PME_DEV_SERVER_URL)
    void pageLoadHadNetworkError (const juce::String&) override
    {
        // Dev server not running: fall back to the embedded build.
        goToURL (getResourceProviderRoot());
    }
#endif
};

juce::String mimeForFile (const juce::String& filename)
{
    auto ext = filename.fromLastOccurrenceOf (".", false, false).toLowerCase();
    if (ext == "html") return "text/html";
    if (ext == "js")   return "text/javascript";
    if (ext == "css")  return "text/css";
    if (ext == "svg")  return "image/svg+xml";
    if (ext == "png")  return "image/png";
    if (ext == "ico")  return "image/x-icon";
    if (ext == "json") return "application/json";
    if (ext == "map")  return "application/json";
    if (ext == "woff2") return "font/woff2";
    if (ext == "woff") return "font/woff";
    return "application/octet-stream";
}

Note noteFromVar (const juce::var& v)
{
    Note n;
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return n;
    n.id = (juce::uint32) propNum (*o, "id");
    n.pitch = (int) propNum (*o, "p", 60.0);
    n.start = propNum (*o, "s");
    n.length = propNum (*o, "l", 0.25);
    n.velocity = (float) propNum (*o, "v", 0.8);
    n.muted = propBool (*o, "m");
    n.channel = (int) propNum (*o, "c", 1.0);
    n.art = (int) propNum (*o, "a", -1.0);
    n.lyric = propStr (*o, "ly");
    return n;
}

ControllerEvent ccFromVar (const juce::var& v)
{
    ControllerEvent e;
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return e;
    e.id = (juce::uint32) propNum (*o, "id");
    e.cc = (int) propNum (*o, "cc", 11.0);
    e.channel = (int) propNum (*o, "c", 1.0);
    e.ppq = propNum (*o, "t");
    e.value = (int) propNum (*o, "v");
    return e;
}

PitchBendEvent pbFromVar (const juce::var& v)
{
    PitchBendEvent e;
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return e;
    e.id = (juce::uint32) propNum (*o, "id");
    e.channel = (int) propNum (*o, "c", 1.0);
    e.ppq = propNum (*o, "t");
    e.value = (int) propNum (*o, "v", 8192.0);
    return e;
}

ChordEvent chordFromVar (const juce::var& v)
{
    ChordEvent e;
    auto* o = v.getDynamicObject();
    if (o == nullptr)
        return e;
    e.id = (juce::uint32) propNum (*o, "id");
    e.start = propNum (*o, "s");
    e.length = propNum (*o, "l", 1.0);
    e.root = (int) propNum (*o, "r");
    e.quality = (int) propNum (*o, "q");
    return e;
}

//==============================================================================
// Partial-patch merges: the frontend sends only the changed fields, so absent
// fields must keep the stored value — a bare fromVar() would reset them to
// their defaults (this was corrupting note lengths on drag, CC lanes on point
// moves, chord spans on root edits, ...).
Note fullNoteFromVar (const juce::var& v, const DocumentSnapshot& snap)
{
    Note n = noteFromVar (v);
    if (auto* o = v.getDynamicObject())
    {
        if (const Note* e = snap.findNote (n.id))
        {
            if (! o->hasProperty ("p")) n.pitch = e->pitch;
            if (! o->hasProperty ("s")) n.start = e->start;
            if (! o->hasProperty ("l")) n.length = e->length;
            if (! o->hasProperty ("v")) n.velocity = e->velocity;
            if (! o->hasProperty ("m")) n.muted = e->muted;
            if (! o->hasProperty ("c")) n.channel = e->channel;
            if (! o->hasProperty ("a")) n.art = e->art;
            if (! o->hasProperty ("ly")) n.lyric = e->lyric;
        }
    }
    return n;
}

ControllerEvent fullCcFromVar (const juce::var& v, const DocumentSnapshot& snap)
{
    ControllerEvent e = ccFromVar (v);
    if (auto* o = v.getDynamicObject())
    {
        if (const ControllerEvent* x = snap.findCc (e.id))
        {
            if (! o->hasProperty ("cc")) e.cc = x->cc;
            if (! o->hasProperty ("c")) e.channel = x->channel;
            if (! o->hasProperty ("t")) e.ppq = x->ppq;
            if (! o->hasProperty ("v")) e.value = x->value;
        }
    }
    return e;
}

PitchBendEvent fullPbFromVar (const juce::var& v, const DocumentSnapshot& snap)
{
    PitchBendEvent e = pbFromVar (v);
    if (auto* o = v.getDynamicObject())
    {
        if (const PitchBendEvent* x = snap.findPb (e.id))
        {
            if (! o->hasProperty ("c")) e.channel = x->channel;
            if (! o->hasProperty ("t")) e.ppq = x->ppq;
            if (! o->hasProperty ("v")) e.value = x->value;
        }
    }
    return e;
}

ChordEvent fullChordFromVar (const juce::var& v, const DocumentSnapshot& snap)
{
    ChordEvent e = chordFromVar (v);
    if (auto* o = v.getDynamicObject())
    {
        if (const ChordEvent* x = snap.findChord (e.id))
        {
            if (! o->hasProperty ("s")) e.start = x->start;
            if (! o->hasProperty ("l")) e.length = x->length;
            if (! o->hasProperty ("r")) e.root = x->root;
            if (! o->hasProperty ("q")) e.quality = x->quality;
        }
    }
    return e;
}

std::vector<ArticulationDef> artsFromVar (const juce::var& v)
{
    std::vector<ArticulationDef> out;
    auto* arr = v.getArray();
    if (arr == nullptr)
        return out;
    for (auto& av : *arr)
    {
        auto* ao = av.getDynamicObject();
        if (ao == nullptr)
            continue;
        ArticulationDef a;
        a.id = (juce::uint32) propNum (*ao, "id");
        a.name = propStr (*ao, "n");
        a.keyswitch = (int) propNum (*ao, "ks", -1.0);
        a.cc = (int) propNum (*ao, "cc", -1.0);
        a.ccValue = (int) propNum (*ao, "v");
        out.push_back (a);
    }
    return out;
}

juce::var artsToVar (const std::vector<ArticulationDef>& arts)
{
    juce::Array<juce::var> arr;
    for (const auto& a : arts)
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("id", (double) a.id);
        o->setProperty ("n", a.name);
        o->setProperty ("ks", a.keyswitch);
        o->setProperty ("cc", a.cc);
        o->setProperty ("v", a.ccValue);
        arr.add (juce::var (o));
    }
    return arr;
}

juce::var okResult (const juce::var& data)
{
    auto o = new juce::DynamicObject();
    o->setProperty ("ok", true);
    o->setProperty ("data", data);
    return juce::var (o);
}

juce::var errorResult (const juce::String& message)
{
    auto o = new juce::DynamicObject();
    o->setProperty ("ok", false);
    o->setProperty ("error", message);
    return juce::var (o);
}

} // namespace

//==============================================================================
UiBridge::UiBridge (PowerMidiEditorAudioProcessor& p)
    : processor (p)
{
    loadResourcesFromZip();
    browser = createBrowser();
    startTimerHz (30);
}

UiBridge::~UiBridge()
{
    stopTimer();
}

void UiBridge::loadResourcesFromZip()
{
    if (PmeAssets::assets_zipSize <= 0)
        return;
    juce::MemoryInputStream mis (PmeAssets::assets_zip,
                                 (size_t) PmeAssets::assets_zipSize, false);
    juce::ZipFile zip (mis);
    for (int i = 0; i < zip.getNumEntries(); ++i)
    {
        auto* entry = zip.getEntry (i);
        if (entry == nullptr || entry->isSymbolicLink || entry->uncompressedSize == 0)
            continue;
        auto stream = zip.createStreamForEntry (i);
        if (stream == nullptr)
            continue;
        juce::MemoryBlock mb;
        stream->readIntoMemoryBlock (mb);
        ResourceData res;
        res.bytes.resize (mb.getSize());
        if (! mb.isEmpty())
            memcpy (res.bytes.data(), mb.getData(), mb.getSize());
        res.mime = mimeForFile (entry->filename);
        juce::String key = "/" + entry->filename;
        key = key.replace ("\\", "/");
        resources[key] = std::move (res);
    }
}

juce::WebBrowserComponent::Options UiBridge::buildOptions()
{
    using Options = juce::WebBrowserComponent::Options;

    Options options;
    options = options.withBackend (Options::Backend::webview2)
                  .withKeepPageLoadedWhenBrowserIsHidden()
                  .withNativeIntegrationEnabled()
                  .withNativeFunction ("invoke",
                      [this] (const auto& args, auto completion)
                      {
                          // Native functions may be invoked off the message
                          // thread; hop so document access stays safe.
                          auto argsCopy = args;
                          juce::MessageManager::callAsync (
                              [this, argsCopy, completion]
                              { completion (handleInvoke (argsCopy)); });
                      })
                  .withResourceProvider (
                      [this] (const juce::String& url) { return getResource (url); }
#if defined (PME_DEV_SERVER_URL)
                      ,
                      juce::String (PME_DEV_SERVER_URL)
#endif
                  );

    // A unique user-data folder per plugin instance: WebView2 only allows one
    // process per folder, and multiple instances are common.
    auto userData = juce::File::getSpecialLocation (juce::File::tempDirectory)
                        .getChildFile ("PME_WebView2_"
                                       + juce::String::toHexString (juce::Random::getSystemRandom().nextInt()));
    userData.createDirectory();
    options = options.withWinWebView2Options (
        juce::WebBrowserComponent::Options::WinWebView2{}
            .withUserDataFolder (userData));

    return options;
}

std::unique_ptr<juce::WebBrowserComponent> UiBridge::createBrowser()
{
    auto b = std::make_unique<SinglePageBrowser> (buildOptions());

#if defined (PME_DEV_SERVER_URL)
    b->goToURL (PME_DEV_SERVER_URL);
#else
    b->goToURL (juce::WebBrowserComponent::getResourceProviderRoot());
#endif
    return b;
}

std::optional<juce::WebBrowserComponent::Resource> UiBridge::getResource (const juce::String& url)
{
    // The provider receives the URL path, e.g. "/" or "/assets/index.js".
    auto path = url.upToFirstOccurrenceOf ("?", false, false);
    if (path.isEmpty() || path == "/")
        path = "/index.html";

    if (auto it = resources.find (path); it != resources.end())
        return juce::WebBrowserComponent::Resource { it->second.bytes, it->second.mime };
    return std::nullopt;
}

//==============================================================================
juce::var UiBridge::handleInvoke (const juce::Array<juce::var>& args)
{
    if (args.isEmpty())
        return errorResult ("empty invoke");
    auto name = args[0].toString();

    if (name == "init")
    {
        auto snap = processor.document.getSnapshot();
        auto data = new juce::DynamicObject();
        data->setProperty ("doc", MidiClipDocument::snapshotToJson (*snap));
        data->setProperty ("settings", processor.settings.toVar());
        data->setProperty ("version", juce::var (JucePlugin_VersionString));
        lastDocRevision = snap->revision;
        lastSettingsRevision = processor.settingsRevision.load();
        docWasPushed = true;
        processor.setUiConnected (true);
        // Doubles as a C++ -> UI non-ASCII transport check: if this toast ever
        // renders as mojibake, the emitEvent chain is broken again.
        pushToastKey ("toast.connected", {{ "version", juce::String (JucePlugin_VersionString) }});
        return okResult (juce::var (data));
    }

    if (name == "doc.edit")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        if (payload == nullptr)
            return errorResult ("doc.edit: missing payload");
        auto ops = payload->getProperty ("ops").getArray();
        if (ops == nullptr)
            return errorResult ("doc.edit: missing ops");
        const auto snap = processor.document.getSnapshot();
        processor.document.beginTransaction (propStr (*payload, "name", "edit"));
        for (auto& opVar : *ops)
        {
            auto* op = opVar.getDynamicObject();
            if (op == nullptr)
                continue;
            auto kind = op->getProperty ("op").toString();
            if (kind == "add")
                processor.document.addNote (noteFromVar (op->getProperty ("note")));
            else if (kind == "update")
                processor.document.updateNotes ({ fullNoteFromVar (op->getProperty ("note"), *snap) });
            else if (kind == "remove")
                processor.document.removeNotes ({ (juce::uint32) (double) op->getProperty ("id") });
            else if (kind == "updateMany")
            {
                std::vector<Note> notes;
                if (auto* arr = op->getProperty ("notes").getArray())
                    for (auto& nv : *arr)
                        notes.push_back (fullNoteFromVar (nv, *snap));
                processor.document.updateNotes (notes);
            }
            else if (kind == "removeMany")
            {
                std::vector<juce::uint32> ids;
                if (auto* arr = op->getProperty ("ids").getArray())
                    for (auto& iv : *arr)
                        ids.push_back ((juce::uint32) (double) iv);
                processor.document.removeNotes (ids);
            }
            else if (kind == "addCC")
            {
                processor.document.addCC (ccFromVar (op->getProperty ("ev")));
            }
            else if (kind == "updateManyCC")
            {
                std::vector<ControllerEvent> evs;
                if (auto* arr = op->getProperty ("evs").getArray())
                    for (auto& evv : *arr)
                        evs.push_back (fullCcFromVar (evv, *snap));
                processor.document.updateCCs (evs);
            }
            else if (kind == "removeManyCC")
            {
                std::vector<juce::uint32> ids;
                if (auto* arr = op->getProperty ("ids").getArray())
                    for (auto& iv : *arr)
                        ids.push_back ((juce::uint32) (double) iv);
                processor.document.removeCCs (ids);
            }
            else if (kind == "addPB")
            {
                processor.document.addPitchBend (pbFromVar (op->getProperty ("ev")));
            }
            else if (kind == "updateManyPB")
            {
                std::vector<PitchBendEvent> evs;
                if (auto* arr = op->getProperty ("evs").getArray())
                    for (auto& evv : *arr)
                        evs.push_back (fullPbFromVar (evv, *snap));
                processor.document.updatePitchBends (evs);
            }
            else if (kind == "removeManyPB")
            {
                std::vector<juce::uint32> ids;
                if (auto* arr = op->getProperty ("ids").getArray())
                    for (auto& iv : *arr)
                        ids.push_back ((juce::uint32) (double) iv);
                processor.document.removePitchBends (ids);
            }
            else if (kind == "addChord")
            {
                processor.document.addChord (chordFromVar (op->getProperty ("chord")));
            }
            else if (kind == "updateManyChords")
            {
                std::vector<ChordEvent> chords;
                if (auto* arr = op->getProperty ("chords").getArray())
                    for (auto& cv : *arr)
                        chords.push_back (fullChordFromVar (cv, *snap));
                processor.document.updateChords (chords);
            }
            else if (kind == "removeManyChords")
            {
                std::vector<juce::uint32> ids;
                if (auto* arr = op->getProperty ("ids").getArray())
                    for (auto& iv : *arr)
                        ids.push_back ((juce::uint32) (double) iv);
                processor.document.removeChords (ids);
            }
        }
        processor.document.commitTransaction();
        auto data = new juce::DynamicObject();
        data->setProperty ("revision", (double) processor.document.getRevision());
        data->setProperty ("canUndo", processor.document.canUndo());
        data->setProperty ("canRedo", processor.document.canRedo());
        return okResult (juce::var (data));
    }

    if (name == "doc.undo" || name == "doc.redo")
    {
        if (name == "doc.undo")
            processor.document.undo();
        else
            processor.document.redo();
        auto data = new juce::DynamicObject();
        data->setProperty ("revision", (double) processor.document.getRevision());
        data->setProperty ("canUndo", processor.document.canUndo());
        data->setProperty ("canRedo", processor.document.canRedo());
        return okResult (juce::var (data));
    }

    if (name == "doc.clear")
    {
        processor.document.beginTransaction ("clear");
        processor.document.clear();
        processor.document.commitTransaction();
        return okResult (juce::var ((double) processor.document.getRevision()));
    }

    if (name == "settings.update")
    {
        if (args.size() > 1)
            processor.updateSettingsFromUi (args[1]);
        auto data = new juce::DynamicObject();
        data->setProperty ("settings", processor.settings.toVar());
        data->setProperty ("revision", (double) processor.settingsRevision.load());
        return okResult (juce::var (data));
    }

    if (name == "audition.start")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        double ppq = payload != nullptr ? propNum (*payload, "ppq") : 0.0;
        processor.getEngine().startAudition (ppq);
        return okResult (juce::var (true));
    }

    if (name == "audition.stop")
    {
        processor.getEngine().stopAudition();
        return okResult (juce::var (true));
    }

    if (name == "preview.note")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        int pitch = payload != nullptr ? (int) propNum (*payload, "p", 60.0) : 60;
        int channel = payload != nullptr ? (int) propNum (*payload, "c", 1.0) : 1;
        float vel = payload != nullptr ? (float) propNum (*payload, "v", 0.8) : 0.8f;
        processor.getEngine().previewNote (pitch, channel, vel);
        return okResult (juce::var (true));
    }

    if (name == "panic")
    {
        processor.getEngine().panic();
        return okResult (juce::var (true));
    }

    if (name == "map.set")
    {
        // payload is { articulations: [...] } — accept the bare array too
        const auto payload = args.size() > 1 ? args[1] : juce::var();
        const auto list = payload.isObject() && payload.getDynamicObject() != nullptr
            ? payload.getDynamicObject()->getProperty ("articulations")
            : payload;
        auto arts = artsFromVar (list);
        processor.document.setArticulations (arts);
        return okResult (artsToVar (processor.document.getArticulations()));
    }

    if (name == "file.exportMidi")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        exportMidiToFile (payload != nullptr ? propStr (*payload, "name", "PowerMidiEditor") : juce::String ("PowerMidiEditor"));
        return okResult (juce::var (true));
    }

    if (name == "file.importMidi")
    {
        importMidiFromFile();
        return okResult (juce::var (true));
    }

    if (name == "file.importMidiData")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto b64 = payload != nullptr ? propStr (*payload, "data") : juce::String();
        juce::MemoryOutputStream decoded;
        MidiFileIO::ImportResult imported;
        if (! juce::Base64::convertFromBase64 (decoded, b64)
            || ! MidiFileIO::importMidiFromMemory (decoded.getData(), (size_t) decoded.getDataSize(), imported))
        {
            pushToastKey ("toast.importFailed");
            return okResult (juce::var (false));
        }
        processor.document.beginTransaction ("Import MIDI");
        processor.document.clear();
        for (auto& n : imported.notes) processor.document.addNote (n);
        for (auto& e : imported.ccs) processor.document.addCC (e);
        for (auto& e : imported.pbs) processor.document.addPitchBend (e);
        processor.document.commitTransaction();
        pushToastKey ("toast.imported", {{ "count", juce::String ((int) imported.notes.size()) }});
        return okResult (juce::var (true));
    }

    if (name == "map.export")
    {
        exportExpressionMap ("PowerMidiEditor-map");
        return okResult (juce::var (true));
    }

    if (name == "map.import")
    {
        importExpressionMap();
        return okResult (juce::var (true));
    }

    if (name == "map.importCubase")
    {
        importCubaseExpressionMap();
        return okResult (juce::var (true));
    }

    if (name == "browser.folders")
    {
        return okResult (processor.browserFolders());
    }

    if (name == "browser.addFolder")
    {
        auto chooser = std::make_unique<juce::FileChooser> ("Add MIDI folder",
            juce::File::getSpecialLocation (juce::File::userDocumentsDirectory), "*");
        auto* raw = chooser.get();
        pendingChoosers.push_back (std::move (chooser));
        raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectDirectories,
            [this, raw] (const juce::FileChooser& fc)
            {
                auto dir = fc.getResult();
                if (dir == juce::File{}) return;
                auto folders = processor.browserFolders();
                const auto newPath = dir.getFullPathName();
                bool exists = false;
                for (const auto& v : folders) if (v.toString() == newPath) exists = true;
                if (! exists) folders.add (newPath);
                processor.browserSetFolders (folders);
            });
        return okResult (juce::var (true));
    }

    if (name == "browser.removeFolder")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        juce::Array<juce::var> keep;
        for (const auto& v : processor.browserFolders())
            if (v.toString() != path) keep.add (v);
        processor.browserSetFolders (keep);
        return okResult (juce::var (true));
    }

    if (name == "browser.preview")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        juce::File f (path);
        juce::uint64 noteCount = 0;
        double len = 0.0;
        if (f.existsAsFile())
        {
            MidiFileIO::ImportResult r;
            if (MidiFileIO::importMidi (f, r))
            {
                noteCount = r.notes.size();
                for (const auto& n : r.notes) len = juce::jmax (len, n.start + n.length);
                for (const auto& e : r.ccs)    len = juce::jmax (len, e.ppq + 0.25);
                for (const auto& e : r.pbs)    len = juce::jmax (len, e.ppq + 0.25);
                processor.startPreview (f);
            }
        }
        auto o = new juce::DynamicObject();
        o->setProperty ("notes", (double) noteCount);
        o->setProperty ("len", len);
        return okResult (juce::var (o));
    }

    if (name == "browser.stopPreview")
    {
        processor.stopPreview();
        return okResult (juce::var (true));
    }

    if (name == "browser.load")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        juce::File f (path);
        if (! f.existsAsFile()) return okResult (juce::var (false));
        processor.stopPreview();
        MidiFileIO::ImportResult r;
        if (! MidiFileIO::importMidi (f, r)) return okResult (juce::var (false));
        processor.document.beginTransaction ("Load from browser");
        processor.document.clear();
        for (const auto& n : r.notes) processor.document.addNote (n);
        for (const auto& e : r.ccs)  processor.document.addCC (e);
        for (const auto& e : r.pbs)  processor.document.addPitchBend (e);
        processor.document.commitTransaction();
        return okResult (juce::var (true));
    }

    if (name == "browser.dragFile")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        juce::File f (path);
        if (f.existsAsFile())
            launchMidiDrag (f);  // drag the REAL file from its folder
        return okResult (juce::var (true));
    }

    if (name == "drummap.load")
    {
        // Parse only - the result lands as a drummapDraft event that fills the
        // editor table; nothing takes effect until the user confirms.
        auto chooser = std::make_unique<juce::FileChooser> ("Load drum map",
            juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),
            "*.bwdrm;*.drm");
        auto* raw = chooser.get();
        pendingChoosers.push_back (std::move (chooser));
        raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
            [this, raw] (const juce::FileChooser& fc)
            {
                auto file = fc.getResult();
                if (file != juce::File{})
                {
                    DrumMapData data;
                    if (DrumMapIO::parse (file, data))
                    {
                        auto o = new juce::DynamicObject();
                        o->setProperty ("name", data.mapName);
                        juce::Array<juce::var> arr;
                        for (const auto& e : data.entries)
                        {
                            auto eo = new juce::DynamicObject();
                            eo->setProperty ("i", e.inNote);
                            eo->setProperty ("o", e.outNote);
                            eo->setProperty ("c", e.channel);
                            eo->setProperty ("name", e.name);
                            arr.add (juce::var (eo));
                        }
                        o->setProperty ("entries", arr);
                        push ("drummapDraft", juce::var (o));
                    }
                    else
                        pushToastKey ("toast.drumMapFailed");
                }
                for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                    if (it->get() == raw) { pendingChoosers.erase (it); break; }
            });
        return okResult (juce::var (true));
    }
    if (name == "drummap.set")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        if (payload != nullptr)
        {
            processor.drumMap.mapName = propStr (*payload, "name", "Custom");
            processor.drumMap.entries.clear();
            if (auto* arr = payload->getProperty ("entries").getArray())
                for (const auto& v : *arr)
                    if (auto* eo = v.getDynamicObject())
                    {
                        const auto name = eo->getProperty ("name").toString().trim();
                        const int inN = juce::jlimit (0, 127, (int) (double) eo->getProperty ("i"));
                        const int outN = juce::jlimit (0, 127, (int) (double) eo->getProperty ("o"));
                        const int ch = juce::jlimit (0, 16, (int) (double) eo->getProperty ("c"));
                        if (name.isNotEmpty())
                            processor.drumMap.entries.push_back ({ name, inN, outN, ch });
                    }
            processor.saveDrumMapPrefs();
            pushDrumMap();
        }
        return okResult (juce::var (true));
    }

    if (name == "drummap.export")
    {
        // Export the DRAFT the editor shows (passed in the payload), so
        // Export… reflects the table before Apply.
        auto payload = args.size() > 1 ? args[1] : juce::var();
        std::vector<DrumMapEntry> rows;
        juce::String exportName = "Custom";
        if (auto* po = payload.getDynamicObject())
        {
            exportName = po->getProperty ("name").toString().trim();
            if (auto* arr = po->getProperty ("entries").getArray())
                for (const auto& v : *arr)
                    if (auto* eo = v.getDynamicObject())
                    {
                        DrumMapEntry e;
                        e.name = eo->getProperty ("name").toString().trim();
                        e.inNote = juce::jlimit (0, 127, (int) (double) eo->getProperty ("i"));
                        e.outNote = juce::jlimit (0, 127, (int) (double) eo->getProperty ("o"));
                        e.channel = juce::jlimit (0, 16, (int) (double) eo->getProperty ("c"));
                        if (e.name.isNotEmpty())
                            rows.push_back (e);
                    }
        }
        if (rows.empty())
        {
            pushToastKey ("toast.drumMapFailed");
            return okResult (juce::var (false));
        }

        auto chooser = std::make_unique<juce::FileChooser> ("Export drum map (.bwdrm)",
            juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),
            "*.bwdrm");
        auto* raw = chooser.get();
        pendingChoosers.push_back (std::move (chooser));
        raw->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
            [this, raw, exportName, rows] (const juce::FileChooser& fc)
            {
                auto file = fc.getResult();
                if (file != juce::File{})
                {
                    auto path = file.getParentDirectory().getChildFile (
                        file.getFileNameWithoutExtension().upToLastOccurrenceOf (".", false, true) + ".bwdrm");
                    juce::String csv;
                    for (const auto& e : rows)
                        csv << e.name << "," << e.inNote << ",0," << e.outNote << "," << e.channel << "\r\n";
                    path.replaceWithText (csv);
                    pushToastKey ("toast.drumMapLoaded", {{ "name", path.getFileName() }});
                }
                for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                    if (it->get() == raw) { pendingChoosers.erase (it); break; }
            });
        return okResult (juce::var (true));
    }

    if (name == "drummap.clear")
    {
        processor.clearDrumMap();
        pushDrumMap();
        return okResult (juce::var (true));
    }

    if (name == "record.set")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        processor.setRecordArmed (payload != nullptr && propBool (*payload, "armed"));
        return okResult (juce::var (true));
    }

    if (name == "transport.play")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        processor.startInternalPlayback (payload != nullptr ? propNum (*payload, "ppq", 0.0) : 0.0);
        return okResult (juce::var (true));
    }

    if (name == "transport.stop")
    {
        processor.stopInternalPlayback();
        return okResult (juce::var (true));
    }

    if (name == "ab.toggle")
    {
        auto data = new juce::DynamicObject();
        data->setProperty ("active", processor.toggleAb());
        return okResult (juce::var (data));
    }

    if (name == "file.dragMidiOut")
    {
        dragMidiOut();
        return okResult (juce::var (true));
    }

    if (name == "file.dragMidiOutSelected")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        std::vector<juce::uint32> ids;
        if (payload != nullptr)
            if (auto* arr = payload->getProperty ("ids").getArray())
                for (const auto& v : *arr)
                    ids.push_back ((juce::uint32) (int) (double) v);
        dragSelectedMidiOut (ids);
        return okResult (juce::var (true));
    }

    if (name == "file.saveProject")
    {
        saveProject();
        return okResult (juce::var (true));
    }

    if (name == "file.openProject")
    {
        openProject();
        return okResult (juce::var (true));
    }

    return errorResult ("unknown invoke: " + name);
}

//==============================================================================
// Best-effort Cubase .expressionmap import: pulls articulation names and
// keyswitch pitches out of the XML where they can be found.
void UiBridge::importCubaseExpressionMap()
{
    auto chooser = std::make_unique<juce::FileChooser> ("Import expression map",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),
        "*.expressionmap;*.xml;*.exprmap;*.json");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [this, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                auto arts = ExpressionMapIO::parse (file);
                if (! arts.empty())
                {
                    processor.document.setArticulations (arts);
                    pushToastKey ("toast.expImportOk", {{ "count", juce::String ((int) arts.size()) }});
                }
                else
                {
                    pushToastKey ("toast.expImportNone");
                }
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

void UiBridge::launchMidiDrag (const juce::File& temp)
{
    // JUCE 9 runs the OLE drag loop on a background thread and it tracks the
    // real mouse state: DoDragDrop cancels immediately unless the primary
    // button is still held. The frontend therefore fires this on pointerdown.
    juce::Component* dragSource = browser.get();
    if (dragSource != nullptr && dragSource->getTopLevelComponent() != nullptr)
        dragSource = dragSource->getTopLevelComponent();
    juce::StringArray files { temp.getFullPathName() };

    juce::DragAndDropContainer::performExternalDragDropOfFiles (files, true, dragSource);
    pushToastKey ("toast.dragOutStarted");
}

void UiBridge::dragMidiOut()
{
    auto snap = processor.document.getSnapshot();
    auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("PowerMidiEditor_Export.mid");
    if (! MidiFileIO::exportMidi (*snap, temp))
    {
        pushToastKey ("toast.dragOutFailed");
        return;
    }
    launchMidiDrag (temp);
}

void UiBridge::dragSelectedMidiOut (const std::vector<juce::uint32>& ids)
{
    if (ids.empty())
    {
        pushToastKey ("toast.dragOutFailed");
        return;
    }
    auto snap = processor.document.getSnapshot();
    bool ok = false;
    auto selected = makeSelectionSnapshot (*snap, ids, ok);
    if (! ok)
    {
        pushToastKey ("toast.dragOutFailed");
        return;
    }
    auto temp = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getChildFile ("PowerMidiEditor_Export.mid");
    if (! MidiFileIO::exportMidi (selected, temp))
    {
        pushToastKey ("toast.dragOutFailed");
        return;
    }
    launchMidiDrag (temp);
}

void UiBridge::saveProject()
{
    auto docVar = processor.document.toVar();
    auto settingsVar = processor.settings.toVar();
    auto chooser = std::make_unique<juce::FileChooser> ("Save project",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile ("PowerMidiEditor.pmeproj"),
        "*.pmeproj");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [this, docVar, settingsVar, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                auto path = file.getParentDirectory().getChildFile (
                    file.getFileNameWithoutExtension() + ".pmeproj");
                auto root = new juce::DynamicObject();
                root->setProperty ("doc", docVar);
                root->setProperty ("settings", settingsVar);
                if (path.replaceWithText (juce::JSON::toString (juce::var (root), true)))
                    pushToastKey ("toast.projectSaved");
                else
                    pushToastKey ("toast.saveFailed");
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

void UiBridge::openProject()
{
    auto chooser = std::make_unique<juce::FileChooser> ("Open project",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory), "*.pmeproj;*.json");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [this, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                auto root = juce::JSON::parse (file.loadFileAsString());
                auto* o = root.getDynamicObject();
                if (o != nullptr && ! o->getProperty ("doc").isVoid())
                {
                    processor.document.loadFromVar (o->getProperty ("doc"));
                    if (auto sv = o->getProperty ("settings"); ! sv.isVoid())
                        processor.settings.loadFromVar (sv);
                    processor.settingsRevision.fetch_add (1, std::memory_order_relaxed);
                    pushToastKey ("toast.projectOpened");
                }
                else
                {
                    pushToastKey ("toast.openFailed");
                }
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

//==============================================================================
void UiBridge::exportMidiToFile (const juce::String& suggestedName)
{
    auto snap = processor.document.getSnapshot();
    auto chooser = std::make_unique<juce::FileChooser> ("Export MIDI file",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile (suggestedName + ".mid"),
        "*.mid");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [this, snap, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                auto path = file.getParentDirectory().getChildFile (
                    file.getFileNameWithoutExtension() + ".mid");
                if (pme::MidiFileIO::exportMidi (*snap, path))
                    pushToast ("MIDI exported: " + path.getFullPathName());
                else
                    pushToast ("Export failed: could not write file");
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

void UiBridge::importMidiFromFile()
{
    auto chooser = std::make_unique<juce::FileChooser> ("Import MIDI file",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory), "*.mid");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [this, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                MidiFileIO::ImportResult imported;
                if (MidiFileIO::importMidi (file, imported))
                {
                    processor.document.beginTransaction ("Import MIDI");
                    processor.document.clear();
                    for (auto& n : imported.notes) processor.document.addNote (n);
                    for (auto& e : imported.ccs) processor.document.addCC (e);
                    for (auto& e : imported.pbs) processor.document.addPitchBend (e);
                    processor.document.commitTransaction();
                    pushToast ("Imported " + juce::String ((int) imported.notes.size()) + " notes from " + file.getFileName());
                }
                else
                {
                    pushToast ("Import failed: could not read " + file.getFileName());
                }
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

void UiBridge::exportExpressionMap (const juce::String& suggestedName)
{
    auto arts = artsToVar (processor.document.getArticulations());
    auto chooser = std::make_unique<juce::FileChooser> ("Export expression map",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory).getChildFile (suggestedName + ".json"),
        "*.json");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::saveMode | juce::FileBrowserComponent::canSelectFiles,
        [this, arts, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                auto path = file.getParentDirectory().getChildFile (
                    file.getFileNameWithoutExtension() + ".json");
                auto json = juce::JSON::toString (arts, true);
                if (path.replaceWithText (json))
                    pushToast ("Expression map exported");
                else
                    pushToast ("Export failed: could not write file");
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

void UiBridge::importExpressionMap()
{
    auto chooser = std::make_unique<juce::FileChooser> ("Import expression map",
        juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),
        "*.json;*.exprmap;*.expressionmap;*.xml");
    auto* raw = chooser.get();
    pendingChoosers.push_back (std::move (chooser));
    raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,
        [this, raw] (const juce::FileChooser& fc)
        {
            auto file = fc.getResult();
            if (file != juce::File{})
            {
                // our JSON format first; Ample Sound CSV / Cubase XML fallback
                auto arts = artsFromVar (juce::JSON::parse (file.loadFileAsString()));
                if (arts.empty())
                    arts = ExpressionMapIO::parse (file);
                if (! arts.empty())
                {
                    processor.document.setArticulations (arts);
                    pushToast ("Expression map imported (" + juce::String ((int) arts.size()) + " articulations)");
                }
                else
                {
                    pushToast ("Import failed: no articulations found");
                }
            }
            for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)
                if (it->get() == raw) { pendingChoosers.erase (it); break; }
        });
}

//==============================================================================
void UiBridge::push (const char* kind, const juce::var& payload)
{
    auto o = new juce::DynamicObject();
    o->setProperty ("kind", juce::String (kind));
    o->setProperty (juce::String (kind), payload);
    browser->emitEventIfBrowserIsVisible ("pme", juce::var (o));
}

void UiBridge::pushToast (const juce::String& message)
{
    push ("toast", juce::var (message));
}

void UiBridge::pushToastKey (const juce::String& key,
    std::vector<std::pair<juce::String, juce::String>> params)
{
    auto o = new juce::DynamicObject();
    o->setProperty ("kind", juce::String ("toast"));
    o->setProperty ("key", key);
    juce::Array<juce::var> arr;
    for (const auto& [k, v] : params)
    {
        auto p = new juce::DynamicObject();
        p->setProperty ("k", k);
        p->setProperty ("v", v);
        arr.add (juce::var (p));
    }
    o->setProperty ("params", arr);
    push ("toast", juce::var (o));
}

void UiBridge::pushDrumMap()
{
    auto o = new juce::DynamicObject();
    o->setProperty ("name", processor.drumMap.mapName);
    juce::Array<juce::var> arr;
    for (const auto& e : processor.drumMap.entries)
    {
        auto eo = new juce::DynamicObject();
        eo->setProperty ("i", e.inNote);
        eo->setProperty ("o", e.outNote);
        eo->setProperty ("c", e.channel);
        eo->setProperty ("name", e.name);
        arr.add (juce::var (eo));
    }
    o->setProperty ("entries", arr);
    push ("drummap", juce::var (o));
}

void UiBridge::pushDoc()
{
    auto snap = processor.document.getSnapshot();
    lastDocRevision = snap->revision;
    push ("doc", MidiClipDocument::snapshotToJson (*snap));
}

void UiBridge::pushSettings()
{
    lastSettingsRevision = processor.settingsRevision.load();
    push ("settings", processor.settings.toVar());
}

void UiBridge::pushTransport()
{
    auto& t = processor.uiTransport;
    bool playing = t.playing.load();
    bool internalPlaying = t.internalPlaying.load();
    double internalPpq = t.internalPpq.load();
    bool auditioning = t.auditioning.load();
    double auditionPpq = t.auditionPpq.load();
    bool ppqValid = t.ppqValid.load();
    double ppq = t.ppq.load();
    bool loopValid = t.loopValid.load();
    double loopStart = t.loopStart.load();
    double loopEnd = t.loopEnd.load();
    double tempo = t.tempo.load();

    if (! playing && ppq == lastTransportPpq && loopValid == lastTransportLoopValid
        && loopStart == lastTransportLoopStart && loopEnd == lastTransportLoopEnd
        && tempo == lastTransportTempo && ppqValid == lastTransportPpqValid
        && internalPlaying == lastTransportInternal
        && internalPpq == lastTransportInternalPpq
        && auditioning == lastTransportAuditioning && auditionPpq == lastTransportAuditionPpq
        && lastPb == t.lastPb.load() && lastCcNumber == t.lastCcNumber.load()
        && lastCcValue == t.lastCcValue.load())
        return;

    lastTransportPpq = ppq;
    lastTransportLoopValid = loopValid;
    lastTransportLoopStart = loopStart;
    lastTransportLoopEnd = loopEnd;
    lastTransportTempo = tempo;
    lastTransportPpqValid = ppqValid;
    lastTransportInternal = internalPlaying;
    lastTransportInternalPpq = internalPpq;
    lastTransportAuditioning = auditioning;
    lastTransportAuditionPpq = auditionPpq;
    lastPb = t.lastPb.load();
    lastCcNumber = t.lastCcNumber.load();
    lastCcValue = t.lastCcValue.load();

    auto o = new juce::DynamicObject();
    o->setProperty ("playing", playing);
    o->setProperty ("internalPlaying", internalPlaying);
    o->setProperty ("internalPpq", internalPpq);
    o->setProperty ("auditioning", auditioning);
    o->setProperty ("auditionPpq", auditionPpq);
    o->setProperty ("ppqValid", ppqValid);
    o->setProperty ("ppq", ppq);
    o->setProperty ("loopValid", loopValid);
    o->setProperty ("loopStart", loopStart);
    o->setProperty ("loopEnd", loopEnd);
    o->setProperty ("tempo", tempo);
    o->setProperty ("sampleRate", processor.uiTransport.sampleRate.load());
    o->setProperty ("sigNum", processor.uiTransport.sigNum.load());
    o->setProperty ("sigDen", processor.uiTransport.sigDen.load());
    o->setProperty ("lastPb", processor.uiTransport.lastPb.load());
    o->setProperty ("lastCcNumber", processor.uiTransport.lastCcNumber.load());
    o->setProperty ("lastCcValue", processor.uiTransport.lastCcValue.load());
    push ("transport", juce::var (o));
}

void UiBridge::pushMidiIn()
{
    juce::Array<juce::var> events;
    PowerMidiEditorAudioProcessor::MidiInEvent ev;
    while (events.size() < 32 && processor.popMidiInEvent (ev))
    {
        auto o = new juce::DynamicObject();
        o->setProperty ("on", ev.isOn);
        o->setProperty ("p", ev.pitch);
        o->setProperty ("c", ev.channel);
        o->setProperty ("v", juce::var (ev.velocity));
        events.add (juce::var (o));
    }
    if (! events.isEmpty())
        push ("midi", juce::var (events));
}

void UiBridge::timerCallback()
{
    processor.drainRecordedNotes();

    if (! docWasPushed)
        return; // wait for the UI to pull initial state via "init"

    if (processor.document.getRevision() != lastDocRevision)
        pushDoc();
    if (processor.settingsRevision.load() != lastSettingsRevision)
        pushSettings();
    pushTransport();
    pushMidiIn();
}

} // namespace pme
