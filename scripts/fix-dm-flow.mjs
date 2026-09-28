// C++ drummap.load: parse to draft event only - no apply, no save.
import fs from 'node:fs';

const cpp = new URL('../Source/Bridge/UiBridge.cpp', import.meta.url);
let b = fs.readFileSync(cpp, 'utf8');

const start = b.indexOf('    if (name == "drummap.load")');
const end = b.indexOf('    if (name == "drummap.set")');
if (start < 0 || end < 0) { console.error('load handler bounds missing'); process.exit(1); }

const newLoad = [
'    if (name == "drummap.load")',
'    {',
'        // Parse only - the result lands as a drummapDraft event that fills the',
'        // editor table; nothing takes effect until the user confirms.',
'        auto chooser = std::make_unique<juce::FileChooser> ("Load drum map",',
'            juce::File::getSpecialLocation (juce::File::userDocumentsDirectory),',
'            "*.bwdrm;*.drm");',
'        auto* raw = chooser.get();',
'        pendingChoosers.push_back (std::move (chooser));',
'        raw->launchAsync (juce::FileBrowserComponent::openMode | juce::FileBrowserComponent::canSelectFiles,',
'            [this, raw] (const juce::FileChooser& fc)',
'            {',
'                auto file = fc.getResult();',
'                if (file != juce::File{})',
'                {',
'                    DrumMapData data;',
'                    if (DrumMapIO::parse (file, data))',
'                    {',
'                        auto o = new juce::DynamicObject();',
'                        o->setProperty ("name", data.mapName);',
'                        juce::Array<juce::var> arr;',
'                        for (const auto& e : data.entries)',
'                        {',
'                            auto eo = new juce::DynamicObject();',
'                            eo->setProperty ("i", e.inNote);',
'                            eo->setProperty ("o", e.outNote);',
'                            eo->setProperty ("c", e.channel);',
'                            eo->setProperty ("name", e.name);',
'                            arr.add (juce::var (eo));',
'                        }',
'                        o->setProperty ("entries", arr);',
'                        push ("drummapDraft", juce::var (o));',
'                    }',
'                    else',
'                        pushToastKey ("toast.drumMapFailed");',
'                }',
'                for (auto it = pendingChoosers.begin(); it != pendingChoosers.end(); ++it)',
'                    if (it->get() == raw) { pendingChoosers.erase (it); break; }',
'            });',
'        return okResult (juce::var (true));',
'    }',
''
].join('\n');

b = b.slice(0, start) + newLoad + b.slice(end);
fs.writeFileSync(cpp, b);

const proc = new URL('../Source/PluginProcessor.cpp', import.meta.url);
let pc = fs.readFileSync(proc, 'utf8');
const lfStart = pc.indexOf('void PowerMidiEditorAudioProcessor::loadDrumMapFile (const juce::File& file)');
const lfEnd = pc.indexOf('void PowerMidiEditorAudioProcessor::saveDrumMapPrefs() const');
if (lfStart < 0 || lfEnd < 0) { console.error('loadDrumMapFile bounds missing'); process.exit(1); }
pc = pc.slice(0, lfStart) + pc.slice(lfEnd);
fs.writeFileSync(proc, pc);

const hp = new URL('../Source/PluginProcessor.h', import.meta.url);
let ph = fs.readFileSync(hp, 'utf8');
ph = ph.replace('    void loadDrumMapFile (const juce::File& file);\n', '');
fs.writeFileSync(hp, ph);

console.log('cpp done: draft-only load, loadDrumMapFile removed');
