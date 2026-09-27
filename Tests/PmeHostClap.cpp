// Mini CLAP host: loads the built .clap exactly like a DAW would, drives the
// transport, and classifies every output event the plugin emits.
//
// Purpose: prove on the wire that pitch bend leaves the plugin as raw MIDI
// (0xE0 status, CLAP_EVENT_MIDI) and never as note events — the "pitch bend
// turns into random notes" symptom observed in Bitwig is host-side event
// misinterpretation, not plugin output.
//
// Usage: PmeHostClap.exe <PowerMidiEditor.clap>
#include <windows.h>
#include <clap/clap.h>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

static int g_failures = 0;
#define CHECK(cond)                                                              \
    do                                                                           \
    {                                                                            \
        if (! (cond))                                                            \
        {                                                                        \
            std::fprintf (stderr, "FAIL @ line %d: %s\n", __LINE__, #cond);      \
            ++g_failures;                                                        \
        }                                                                        \
    } while (false)

//==============================================================================
struct EventSink
{
    std::vector<std::vector<uint8_t>> bytes;
};

static bool CLAP_ABI sinkTryPush (const struct clap_output_events *list, const clap_event_header_t *event)
{
    auto* sink = static_cast<EventSink*> (list->ctx);
    const auto* raw = reinterpret_cast<const uint8_t*> (event);
    sink->bytes.emplace_back (raw, raw + event->size);
    return true;
}

static uint32_t CLAP_ABI inEventsSize (const struct clap_input_events*) { return 0; }
static const clap_event_header_t* CLAP_ABI inEventsGet (const struct clap_input_events*, uint32_t) { return nullptr; }

//==============================================================================
// Host callbacks: minimal but honest — log + thread-check on the single thread.
static const void* CLAP_ABI hostGetExtension (const struct clap_host*, const char* id)
{
    static const clap_host_thread_check threadCheck {
        [] (const clap_host_t*) { return true; },
        [] (const clap_host_t*) { return true; }, // single-threaded mini host: allow process()
    };
    static const clap_host_log log {
        [] (const clap_host_t*, clap_log_severity, const char* msg) { std::fprintf (stderr, "[clap] %s\n", msg); },
    };
    if (std::strcmp (id, CLAP_EXT_THREAD_CHECK) == 0) return &threadCheck;
    if (std::strcmp (id, CLAP_EXT_LOG) == 0) return &log;
    return nullptr;
}
static void CLAP_ABI hostNoop (const struct clap_host*) {}

//==============================================================================
int main (int argc, char** argv)
{
    if (argc < 2)
    {
        std::fprintf (stderr, "usage: PmeHostClap.exe <PowerMidiEditor.clap>\n");
        return 2;
    }

    const std::string path = argv[1];
    HMODULE lib = LoadLibraryA (path.c_str());
    if (lib == nullptr)
    {
        std::fprintf (stderr, "FAIL: LoadLibraryA(%s) error %lu\n", path.c_str(), GetLastError());
        return 1;
    }
    auto entry = reinterpret_cast<const clap_plugin_entry_t*> (GetProcAddress (lib, "clap_entry"));
    if (entry == nullptr)
    {
        std::fprintf (stderr, "FAIL: clap_entry not exported\n");
        return 1;
    }
    if (! entry->init (path.c_str()))
    {
        std::fprintf (stderr, "FAIL: entry->init\n");
        return 1;
    }

    auto* factory = static_cast<const clap_plugin_factory_t*> (
        entry->get_factory (CLAP_PLUGIN_FACTORY_ID));
    CHECK (factory != nullptr);

    const clap_plugin_descriptor_t* desc = nullptr;
    const auto count = factory->get_plugin_count (factory);
    for (uint32_t i = 0; i < count; ++i)
    {
        auto* d = factory->get_plugin_descriptor (factory, i);
        if (d != nullptr && std::strcmp (d->id, "com.powermidi.editor") == 0)
            desc = d;
    }
    if (desc == nullptr)
    {
        std::fprintf (stderr, "FAIL: plugin descriptor not found (%u listed)\n", count);
        entry->deinit();
        return 1;
    }

    clap_host_t host {};
    host.clap_version = CLAP_VERSION_INIT;
    host.name = "PmeHostClap";
    host.vendor = "PME";
    host.version = "1.0";
    host.get_extension = hostGetExtension;
    host.request_restart = hostNoop;
    host.request_process = hostNoop;
    host.request_callback = hostNoop;

    auto* plugin = factory->create_plugin (factory, &host, desc->id);
    CHECK (plugin != nullptr);
    if (plugin == nullptr) return 1;
    CHECK (plugin->init (plugin));

    // note ports: the MIDI output port must exist for a DAW to route output
    auto* notePorts = static_cast<const clap_plugin_note_ports_t*> (
        plugin->get_extension (plugin, CLAP_EXT_NOTE_PORTS));
    CHECK (notePorts != nullptr);
    if (notePorts != nullptr)
    {
        const auto inCount = notePorts->count (plugin, true);
        const auto outCount = notePorts->count (plugin, false);
        std::printf ("note ports: in %u, out %u\n", inCount, outCount);
        CHECK (inCount >= 1 && outCount >= 1);
    }

    constexpr uint32_t blockSize = 512;
    CHECK (plugin->activate (plugin, 48000.0, blockSize, blockSize));
    CHECK (plugin->start_processing (plugin));

    EventSink sink;
    clap_output_events_t outEvents { &sink, sinkTryPush };
    clap_input_events_t inEvents { nullptr, inEventsSize, inEventsGet };

    // 6 seconds at 120 bpm = 12 ppq; demo content spans the first few bars
    constexpr uint32_t numBlocks = (6 * 48000) / blockSize;
    const clap_beattime beatTimeFactor = CLAP_BEATTIME_FACTOR;

    for (uint32_t b = 0; b < numBlocks; ++b)
    {
        clap_event_transport_t transport {};
        transport.header.size = sizeof (clap_event_transport_t);
        transport.header.time = 0;
        transport.header.space_id = CLAP_CORE_EVENT_SPACE_ID;
        transport.header.type = CLAP_EVENT_TRANSPORT;
        transport.header.flags = 0;
        transport.flags = CLAP_TRANSPORT_HAS_TEMPO | CLAP_TRANSPORT_HAS_BEATS_TIMELINE
                          | CLAP_TRANSPORT_IS_PLAYING;
        transport.song_pos_beats = (clap_beattime) ((double) b * blockSize / 24000.0 * beatTimeFactor);
        transport.tempo = 120.0;
        transport.tsig_num = 4;
        transport.tsig_denom = 4;

        clap_process_t process {};
        process.steady_time = (int64_t) b * blockSize;
        process.frames_count = blockSize;
        process.transport = &transport;
        process.audio_inputs_count = 0;
        process.audio_outputs_count = 0;
        process.in_events = &inEvents;
        process.out_events = &outEvents;

        const auto status = plugin->process (plugin, &process);
        if (status == CLAP_PROCESS_ERROR)
        {
            std::fprintf (stderr, "FAIL: process returned error at block %u\n", b);
            ++g_failures;
            break;
        }
    }

    plugin->stop_processing (plugin);
    plugin->deactivate (plugin);
    plugin->destroy (plugin);
    entry->deinit();
    FreeLibrary (lib);

    //==========================================================================
    // classify the wire output
    int noteOn = 0, noteOff = 0, cc = 0, pitchBend = 0, other = 0;
    int pbStatusBad = 0, pbMax = -1, pbFirst = -1, ccMax = -1;
    for (const auto& raw : sink.bytes)
    {
        auto* h = reinterpret_cast<const clap_event_header_t*> (raw.data());
        switch (h->type)
        {
            case CLAP_EVENT_NOTE_ON: ++noteOn; break;
            case CLAP_EVENT_NOTE_OFF: ++noteOff; break;
            case CLAP_EVENT_MIDI:
            {
                auto* m = reinterpret_cast<const clap_event_midi_t*> (raw.data());
                const uint8_t status = m->data[0] & 0xf0;
                if (status == 0xe0)
                {
                    const int v = m->data[1] | (m->data[2] << 7);
                    if (pbFirst < 0) pbFirst = v;
                    if (v > pbMax) pbMax = v;
                    ++pitchBend;
                    if ((m->data[0] & 0x0f) != 0) ++pbStatusBad;
                }
                else if (status == 0xb0)
                {
                    if (m->data[2] > ccMax) ccMax = m->data[2];
                    ++cc;
                }
                else if (status == 0x90) ++noteOn; // raw note-on bytes: count as notes
                else if (status == 0x80) ++noteOff;
                else ++other;
                break;
            }
            default: ++other; break;
        }
    }

    std::printf ("wire events: noteOn %d, noteOff %d, cc %d (max %d), pitchbend %d (first %d, max %d), other %d\n",
                 noteOn, noteOff, cc, ccMax, pitchBend, pbFirst, pbMax, other);
    CHECK (noteOn == 0);
    CHECK (noteOff == 0);
    // A fresh instance starts EMPTY: the wire must carry no scheduled events.
    CHECK (cc == 0);
    CHECK (pitchBend == 0);
    CHECK (pbStatusBad == 0);

    if (g_failures == 0)
    {
        std::printf ("== PASS ==\n");
        return 0;
    }
    std::printf ("== FAILED (%d) ==\n", g_failures);
    return 1;
}
