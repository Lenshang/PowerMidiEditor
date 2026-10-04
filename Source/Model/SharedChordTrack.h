#pragma once

#include <juce_core/juce_core.h>

#if _WIN32
 #ifndef WIN32_LEAN_AND_MEAN
  #define WIN32_LEAN_AND_MEAN
 #endif
 #ifndef NOMINMAX
  #define NOMINMAX
 #endif
 #include <windows.h>
#else
 #include <fcntl.h>
 #include <sys/mman.h>
 #include <unistd.h>
#endif

#include <atomic>
#include <cstring>

namespace pme
{

// Cross-instance chord-track sharing: a small named shared-memory segment
// holding a JSON chord list plus a version counter. Every plugin instance
// maps the same segment, so editing the chord track in one instance is seen
// by all others on the same machine — across DAW plugin sandboxes.
//
// Layout: [magic u32][version u32][payloadSize u32][payload bytes...].
// Writers store the payload then bump the version with release ordering;
// readers acquire the version and re-read when it changed. Chords are tiny,
// so version polling from the message thread costs nothing.
class SharedChordTrack
{
public:
    static constexpr size_t kPayloadBytes = 64 * 1024;

    SharedChordTrack()
    {
#if _WIN32
        handle = CreateFileMappingA (INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
                                     0, (DWORD) segmentBytes(), kName);
        if (handle == nullptr)
            error = (uint32_t) GetLastError();
#else
        fd = shm_open (kName, O_RDWR, 0666); // existing segment keeps its content
        if (fd < 0)
        {
            error = (uint32_t) errno;
            fd = shm_open (kName, O_CREAT | O_RDWR, 0666);
        }
        if (fd < 0)
        {
            error = (uint32_t) errno;
        }
        else
        {
            // macOS rejects ftruncate-to-same-size on a shm object with
            // EINVAL (reads it as a shrink), so only size it when needed.
            struct stat st;
            if (fstat (fd, &st) != 0 || st.st_size < (off_t) segmentBytes())
            {
                if (ftruncate (fd, (off_t) segmentBytes()) != 0)
                {
                    error = (uint32_t) errno;
                    close (fd);
                    fd = -1;
                }
            }
        }
        if (fd >= 0)
        {
            map = mmap (nullptr, segmentBytes(), PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
            if (map == MAP_FAILED)
            {
                error = (uint32_t) errno;
                close (fd);
                fd = -1;
                map = nullptr;
            }
        }
        if (fd >= 0)
            error = 0; // a stale probe errno (e.g. ENOENT) is not a real failure
#endif
#if _WIN32
        if (handle == nullptr)
            return;
        view = MapViewOfFile (handle, FILE_MAP_ALL_ACCESS, 0, 0, segmentBytes());
        if (view == nullptr)
        {
            CloseHandle (handle);
            handle = nullptr;
        }
#else
        // map != nullptr is the validity signal on POSIX
#endif
        if (! valid())
            return; // open/mapping failed: callers see valid()==false and error
        auto* m = base();
        if (m->magic.load (std::memory_order_relaxed) != kMagic)
        {
            m->magic.store (kMagic, std::memory_order_relaxed);
            m->version.store (0, std::memory_order_relaxed);
            m->payloadSize.store (0, std::memory_order_relaxed);
        }
    }

    ~SharedChordTrack()
    {
        if (! valid())
            return;
#if _WIN32
        UnmapViewOfFile (view);
        CloseHandle (handle);
#else
        munmap (base(), segmentBytes());
        close (fd);
        // intentionally NOT shm_unlink: the segment must outlive instances so
        // the next one picks up the current chord track
#endif
    }

    bool valid() const
    {
#if _WIN32
        return view != nullptr;
#else
        return fd >= 0;
#endif
    }

    /** Platform error code from the failed open/mapping (0 when valid). */
    uint32_t openError() const { return error; }

    /** Publishes the chord JSON and bumps the version. Returns false when the
     *  segment is unavailable or the payload does not fit. */
    bool publish (const juce::String& chordsJson, uint32_t& versionOut)
    {
        if (! valid())
            return false;
        auto* m = base();
        const auto bytes = chordsJson.toRawUTF8();
        const auto size = (uint32_t) chordsJson.getNumBytesAsUTF8();
        if (size > kPayloadBytes)
            return false;
        std::memcpy (m->payload, bytes, size);
        m->payloadSize.store (size, std::memory_order_release);
        const uint32_t v = m->version.load (std::memory_order_relaxed) + 1;
        m->version.store (v, std::memory_order_release);
        versionOut = v;
        return true;
    }

    /** Returns the current version, or 0 when unavailable/empty. */
    uint32_t currentVersion() const
    {
        return valid() ? base()->version.load (std::memory_order_acquire) : 0;
    }

    /** Fetches the payload for a version; false when unavailable or empty. */
    bool fetch (juce::String& chordsJsonOut)
    {
        if (! valid())
            return false;
        auto* m = base();
        const auto size = m->payloadSize.load (std::memory_order_acquire);
        if (size == 0 || size > kPayloadBytes)
            return false;
        chordsJsonOut = juce::String::fromUTF8 (m->payload, (int) size);
        return true;
    }

private:
    static constexpr const char* kName =
#if _WIN32
        "Local\\PowerMidiEditor.ChordTrack.v1";
#else
        "/PME.Chords.v1";
#endif
    static constexpr uint32_t kMagic = 0x504D4543; // "PMEC"

    struct Layout
    {
        std::atomic<uint32_t> magic;
        std::atomic<uint32_t> version;
        std::atomic<uint32_t> payloadSize;
        char payload[kPayloadBytes];
    };

    static constexpr size_t segmentBytes() { return sizeof (Layout); }
    Layout* base() const
    {
#if _WIN32
        return static_cast<Layout*> (view);
#else
        return static_cast<Layout*> (map);
#endif
    }

#if _WIN32
    void* handle = nullptr;
    void* view = nullptr;
    uint32_t error = 0;
#else
    int fd = -1;
    void* map = nullptr;
    uint32_t error = 0;
#endif
};

} // namespace pme
