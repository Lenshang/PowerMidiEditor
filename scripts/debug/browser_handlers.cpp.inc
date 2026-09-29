    if (name == "browser.folders")
    {
        juce::Array<juce::var> out;
        if (auto* o = uiPrefsFile().existsAsFile()
                ? juce::JSON::parse (uiPrefsFile().loadFileAsString()).getDynamicObject() : nullptr)
            if (auto* arr = o->getProperty ("browserFolders").getArray())
                for (const auto& v : *arr) out.add (v);
        return okResult (juce::var (out));
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
                auto prefs = uiPrefsFile();
                auto parsed = juce::JSON::parse (prefs.existsAsFile() ? prefs.loadFileAsString() : juce::String());
                auto* po = parsed.getDynamicObject();
                if (po == nullptr) { po = new juce::DynamicObject(); parsed = juce::var (po); }
                juce::Array<juce::var> folders;
                if (auto* arr = po->getProperty ("browserFolders").getArray())
                    for (const auto& v : *arr) folders.add (v);
                const auto newPath = dir.getFullPathName();
                bool exists = false;
                for (const auto& v : folders) if (v.toString() == newPath) exists = true;
                if (! exists) folders.add (newPath);
                po->setProperty ("browserFolders", folders);
                prefs.getParentDirectory().createDirectory();
                prefs.replaceWithText (juce::JSON::toString (parsed, juce::JSON::FormatOptions().withSpacing (juce::JSON::Spacing::multiLine)));
            });
        return okResult (juce::var (true));
    }

    if (name == "browser.removeFolder")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        auto prefs = uiPrefsFile();
        auto parsed = juce::JSON::parse (prefs.existsAsFile() ? prefs.loadFileAsString() : juce::String());
        if (auto* po = parsed.getDynamicObject())
            if (auto* arr = po->getProperty ("browserFolders").getArray())
            {
                juce::Array<juce::var> keep;
                for (const auto& v : *arr) if (v.toString() != path) keep.add (v);
                po->setProperty ("browserFolders", keep);
            }
        prefs.replaceWithText (juce::JSON::toString (parsed, juce::JSON::FormatOptions().withSpacing (juce::JSON::Spacing::multiLine)));
        return okResult (juce::var (true));
    }

    if (name == "browser.listFiles")
    {
        juce::Array<juce::var> files;
        if (auto* o = uiPrefsFile().existsAsFile()
                ? juce::JSON::parse (uiPrefsFile().loadFileAsString()).getDynamicObject() : nullptr)
            if (auto* arr = o->getProperty ("browserFolders").getArray())
                for (const auto& v : *arr)
                {
                    juce::File dir (v.toString());
                    if (! dir.isDirectory()) continue;
                    juce::Array<juce::File> found;
                    dir.findChildFiles (found, juce::File::findFiles, false, "*.mid;*.midi;*.MID;*.MIDI");
                    for (const auto& f : found)
                    {
                        auto fo = new juce::DynamicObject();
                        fo->setProperty ("name", f.getFileName());
                        fo->setProperty ("folder", dir.getFullPathName());
                        fo->setProperty ("path", f.getFullPathName());
                        fo->setProperty ("size", (double) f.getSize());
                        files.add (juce::var (fo));
                    }
                }
        auto o = new juce::DynamicObject();
        o->setProperty ("files", files);
        return okResult (juce::var (o));
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
                auto snap = std::make_shared<const DocumentSnapshot> (
                    DocumentSnapshot { r.notes, r.ccs, r.pbs, {}, {}, 1 });
                previewSnap = snap;
                previewActive.store (true, std::memory_order_relaxed);
                engine.setPreview (previewSnap.get(), len);
            }
        }
        auto o = new juce::DynamicObject();
        o->setProperty ("notes", (double) noteCount);
        o->setProperty ("len", len);
        return okResult (juce::var (o));
    }

    if (name == "browser.stopPreview")
    {
        stopPreview();
        return okResult (juce::var (true));
    }

    if (name == "browser.load")
    {
        auto* payload = args.size() > 1 ? args[1].getDynamicObject() : nullptr;
        const auto path = payload != nullptr ? propStr (*payload, "path") : juce::String();
        juce::File f (path);
        if (! f.existsAsFile()) return okResult (juce::var (false));
        stopPreview();
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

