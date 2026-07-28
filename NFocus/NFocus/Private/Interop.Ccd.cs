// Interop.Ccd.cs -- Windows CCD (Connecting and Configuring Displays) API.
//
// Why CCD and not ChangeDisplaySettingsEx: GDI device names are not stable.
// During development \\.\DISPLAY2 was the ASUS in one probe and the TV in the
// next, because they share a physical port. Any save/restore keyed on device
// name is broken by construction. CCD lets us snapshot the exact path+mode
// arrays and replay them verbatim.
//
// THE LUID TRAP: adapterId is a LUID that the graphics stack REGENERATES ON
// EVERY BOOT. A blob containing raw LUIDs fails SetDisplayConfig with
// ERROR_INVALID_PARAMETER after a reboot. So the blob also carries a map of
// LUID -> stable adapter device path, and RemapAdapterIds() rewrites every
// adapterId in both arrays against the current LUIDs before applying.
//
// Must compile under the PS 5.1 Add-Type compiler (C# 5): no expression-bodied
// members, no string interpolation, no tuples, no "out var".

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace NFocus
{
    [StructLayout(LayoutKind.Sequential)]
    public struct LUID
    {
        public uint LowPart;
        public int HighPart;

        public ulong ToKey()
        {
            return ((ulong)(uint)HighPart << 32) | (ulong)LowPart;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_RATIONAL
    {
        public uint Numerator;
        public uint Denominator;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_2DREGION
    {
        public uint cx;
        public uint cy;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINTL
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECTL
    {
        public int left;
        public int top;
        public int right;
        public int bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_PATH_SOURCE_INFO
    {
        public LUID adapterId;
        public uint id;
        // Union of modeInfoIdx / {cloneGroupId:16, sourceModeInfoIdx:16}.
        // Kept as the raw 32 bits; 0xFFFFFFFF is the invalid sentinel under
        // both interpretations.
        public uint modeInfoIdx;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_PATH_TARGET_INFO
    {
        public LUID adapterId;
        public uint id;
        public uint modeInfoIdx;
        public uint outputTechnology;
        public uint rotation;
        public uint scaling;
        public DISPLAYCONFIG_RATIONAL refreshRate;
        public uint scanLineOrdering;
        public int targetAvailable;
        public uint statusFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_PATH_INFO
    {
        public DISPLAYCONFIG_PATH_SOURCE_INFO sourceInfo;
        public DISPLAYCONFIG_PATH_TARGET_INFO targetInfo;
        public uint flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_VIDEO_SIGNAL_INFO
    {
        public ulong pixelRate;
        public DISPLAYCONFIG_RATIONAL hSyncFreq;
        public DISPLAYCONFIG_RATIONAL vSyncFreq;
        public DISPLAYCONFIG_2DREGION activeSize;
        public DISPLAYCONFIG_2DREGION totalSize;
        public uint videoStandard;
        public uint scanLineOrdering;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_TARGET_MODE
    {
        public DISPLAYCONFIG_VIDEO_SIGNAL_INFO targetVideoSignalInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_SOURCE_MODE
    {
        public uint width;
        public uint height;
        public uint pixelFormat;
        public POINTL position;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_DESKTOP_IMAGE_INFO
    {
        public POINTL PathSourceSize;
        public RECTL DesktopImageRegion;
        public RECTL DesktopImageClip;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct DISPLAYCONFIG_MODE_INFO_UNION
    {
        [FieldOffset(0)] public DISPLAYCONFIG_TARGET_MODE targetMode;
        [FieldOffset(0)] public DISPLAYCONFIG_SOURCE_MODE sourceMode;
        [FieldOffset(0)] public DISPLAYCONFIG_DESKTOP_IMAGE_INFO desktopImageInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_MODE_INFO
    {
        public uint infoType;
        public uint id;
        public LUID adapterId;
        public DISPLAYCONFIG_MODE_INFO_UNION modeInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_DEVICE_INFO_HEADER
    {
        public uint type;
        public uint size;
        public LUID adapterId;
        public uint id;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAYCONFIG_TARGET_DEVICE_NAME
    {
        public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
        public uint flags;
        public uint outputTechnology;
        public ushort edidManufactureId;
        public ushort edidProductCodeId;
        public uint connectorInstance;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string monitorFriendlyDeviceName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string monitorDevicePath;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DISPLAYCONFIG_ADAPTER_NAME
    {
        public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string adapterDevicePath;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct DISPLAYCONFIG_TARGET_PREFERRED_MODE
    {
        public DISPLAYCONFIG_DEVICE_INFO_HEADER header;
        public uint width;
        public uint height;
        public DISPLAYCONFIG_TARGET_MODE targetMode;
    }

    /// <summary>One display target, flattened for easy consumption from PowerShell.</summary>
    public class TargetInfo
    {
        public int PathIndex;
        public ulong AdapterKey;
        public uint TargetId;
        public uint SourceId;
        public bool Active;
        public string FriendlyName;
        public string DevicePath;
        public string HardwareId;      // e.g. "TCL9653" -- the stable identity key
        public uint OutputTechnology;
        public uint Width;
        public uint Height;
        public int PositionX;
        public int PositionY;
        public bool IsPrimary;
        public uint RefreshNumerator;
        public uint RefreshDenominator;
    }

    /// <summary>A deserialized topology plus its LUID -> adapter device path map.</summary>
    public class CcdConfig
    {
        public DISPLAYCONFIG_PATH_INFO[] Paths;
        public DISPLAYCONFIG_MODE_INFO[] Modes;
        public Dictionary<ulong, string> AdapterPaths = new Dictionary<ulong, string>();
        public uint QueryFlags;
    }

    public static class Ccd
    {
        public const uint QDC_ALL_PATHS          = 0x00000001;
        public const uint QDC_ONLY_ACTIVE_PATHS  = 0x00000002;
        public const uint QDC_VIRTUAL_MODE_AWARE = 0x00000010;

        public const uint SDC_TOPOLOGY_EXTEND            = 0x00000004;
        public const uint SDC_USE_SUPPLIED_DISPLAY_CONFIG = 0x00000020;
        public const uint SDC_VALIDATE                   = 0x00000040;
        public const uint SDC_APPLY                      = 0x00000080;
        public const uint SDC_SAVE_TO_DATABASE           = 0x00000200;
        public const uint SDC_ALLOW_CHANGES              = 0x00000400;
        public const uint SDC_FORCE_MODE_ENUMERATION     = 0x00001000;
        public const uint SDC_ALLOW_PATH_ORDER_CHANGES   = 0x00002000;
        public const uint SDC_VIRTUAL_MODE_AWARE         = 0x00008000;

        public const uint DISPLAYCONFIG_PATH_ACTIVE = 0x00000001;
        public const uint INVALID_MODE_INDEX        = 0xFFFFFFFF;

        public const uint MODE_INFO_TYPE_SOURCE        = 1;
        public const uint MODE_INFO_TYPE_TARGET        = 2;
        public const uint MODE_INFO_TYPE_DESKTOP_IMAGE = 3;

        private const uint DEVICE_INFO_GET_TARGET_NAME           = 2;
        private const uint DEVICE_INFO_GET_TARGET_PREFERRED_MODE = 3;
        private const uint DEVICE_INFO_GET_ADAPTER_NAME          = 4;

        public const int ERROR_SUCCESS = 0;

        [DllImport("user32.dll")]
        private static extern int GetDisplayConfigBufferSizes(
            uint flags, out uint numPathArrayElements, out uint numModeInfoArrayElements);

        [DllImport("user32.dll")]
        private static extern int QueryDisplayConfig(
            uint flags,
            ref uint numPathArrayElements, [Out] DISPLAYCONFIG_PATH_INFO[] pathArray,
            ref uint numModeInfoArrayElements, [Out] DISPLAYCONFIG_MODE_INFO[] modeInfoArray,
            IntPtr currentTopologyId);

        [DllImport("user32.dll")]
        private static extern int SetDisplayConfig(
            uint numPathArrayElements, [In] DISPLAYCONFIG_PATH_INFO[] pathArray,
            uint numModeInfoArrayElements, [In] DISPLAYCONFIG_MODE_INFO[] modeInfoArray,
            uint flags);

        [DllImport("user32.dll")]
        private static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_TARGET_DEVICE_NAME req);

        [DllImport("user32.dll")]
        private static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_ADAPTER_NAME req);

        [DllImport("user32.dll")]
        private static extern int DisplayConfigGetDeviceInfo(ref DISPLAYCONFIG_TARGET_PREFERRED_MODE req);

        // ------------------------------------------------------------ query --

        /// <summary>
        /// Snapshot the display configuration. Use QDC_ALL_PATHS to FIND a
        /// dormant target (the TV when connected but not enabled); use
        /// QDC_ONLY_ACTIVE_PATHS to SAVE a clean payload for replay. Feeding a
        /// full all-paths array back to SetDisplayConfig invites validation
        /// failures over paths you never cared about.
        /// </summary>
        public static CcdConfig Query(uint flags)
        {
            uint pathCount = 0;
            uint modeCount = 0;

            int rc = GetDisplayConfigBufferSizes(flags, out pathCount, out modeCount);
            if (rc != ERROR_SUCCESS)
            {
                throw new InvalidOperationException(
                    "GetDisplayConfigBufferSizes failed with " + rc + " (" + Describe(rc) + ")");
            }

            DISPLAYCONFIG_PATH_INFO[] paths = new DISPLAYCONFIG_PATH_INFO[pathCount];
            DISPLAYCONFIG_MODE_INFO[] modes = new DISPLAYCONFIG_MODE_INFO[modeCount];

            rc = QueryDisplayConfig(flags, ref pathCount, paths, ref modeCount, modes, IntPtr.Zero);
            if (rc != ERROR_SUCCESS)
            {
                throw new InvalidOperationException(
                    "QueryDisplayConfig failed with " + rc + " (" + Describe(rc) + ")");
            }

            // The API may return fewer elements than the buffer sizes suggested.
            Array.Resize(ref paths, (int)pathCount);
            Array.Resize(ref modes, (int)modeCount);

            CcdConfig cfg = new CcdConfig();
            cfg.Paths = paths;
            cfg.Modes = modes;
            cfg.QueryFlags = flags;
            cfg.AdapterPaths = BuildAdapterMap(paths, modes);
            return cfg;
        }

        private static Dictionary<ulong, string> BuildAdapterMap(
            DISPLAYCONFIG_PATH_INFO[] paths, DISPLAYCONFIG_MODE_INFO[] modes)
        {
            Dictionary<ulong, string> map = new Dictionary<ulong, string>();

            for (int i = 0; i < paths.Length; i++)
            {
                AddAdapter(map, paths[i].sourceInfo.adapterId);
                AddAdapter(map, paths[i].targetInfo.adapterId);
            }
            for (int i = 0; i < modes.Length; i++)
            {
                AddAdapter(map, modes[i].adapterId);
            }
            return map;
        }

        private static void AddAdapter(Dictionary<ulong, string> map, LUID luid)
        {
            ulong key = luid.ToKey();
            if (map.ContainsKey(key)) { return; }

            string path = GetAdapterDevicePath(luid);
            if (!string.IsNullOrEmpty(path)) { map[key] = path; }
        }

        public static string GetAdapterDevicePath(LUID adapterId)
        {
            DISPLAYCONFIG_ADAPTER_NAME req = new DISPLAYCONFIG_ADAPTER_NAME();
            req.header.type = DEVICE_INFO_GET_ADAPTER_NAME;
            req.header.size = (uint)Marshal.SizeOf(typeof(DISPLAYCONFIG_ADAPTER_NAME));
            req.header.adapterId = adapterId;
            req.header.id = 0;

            if (DisplayConfigGetDeviceInfo(ref req) != ERROR_SUCCESS) { return null; }
            return req.adapterDevicePath;
        }

        public static bool TryGetTargetName(LUID adapterId, uint targetId,
                                            out string friendlyName, out string devicePath)
        {
            friendlyName = null;
            devicePath = null;

            DISPLAYCONFIG_TARGET_DEVICE_NAME req = new DISPLAYCONFIG_TARGET_DEVICE_NAME();
            req.header.type = DEVICE_INFO_GET_TARGET_NAME;
            req.header.size = (uint)Marshal.SizeOf(typeof(DISPLAYCONFIG_TARGET_DEVICE_NAME));
            req.header.adapterId = adapterId;
            req.header.id = targetId;

            if (DisplayConfigGetDeviceInfo(ref req) != ERROR_SUCCESS) { return false; }

            friendlyName = req.monitorFriendlyDeviceName;
            devicePath = req.monitorDevicePath;
            return true;
        }

        /// <summary>
        /// "\\?\DISPLAY#TCL9653#5&3a582aa4&0&UID4352#{guid}" -> "TCL9653".
        /// Deliberately parses the string rather than bit-decoding
        /// edidManufactureId, which is a byte-swapped 5-bit-packed PNP id and
        /// needless risk when the value is right there in the path.
        /// </summary>
        public static string ParseHardwareId(string devicePath)
        {
            if (string.IsNullOrEmpty(devicePath)) { return null; }
            string[] parts = devicePath.Split('#');
            if (parts.Length < 2) { return null; }
            return parts[1];
        }

        public static bool TryGetPreferredMode(LUID adapterId, uint targetId,
                                               out uint width, out uint height)
        {
            width = 0;
            height = 0;

            DISPLAYCONFIG_TARGET_PREFERRED_MODE req = new DISPLAYCONFIG_TARGET_PREFERRED_MODE();
            req.header.type = DEVICE_INFO_GET_TARGET_PREFERRED_MODE;
            req.header.size = (uint)Marshal.SizeOf(typeof(DISPLAYCONFIG_TARGET_PREFERRED_MODE));
            req.header.adapterId = adapterId;
            req.header.id = targetId;

            if (DisplayConfigGetDeviceInfo(ref req) != ERROR_SUCCESS) { return false; }

            width = req.width;
            height = req.height;
            return true;
        }

        /// <summary>
        /// Decode sourceInfo.modeInfoIdx into an index into the mode array.
        /// The field is a union: a plain index normally, but under
        /// QDC_VIRTUAL_MODE_AWARE it splits into
        /// {cloneGroupId:16; sourceModeInfoIdx:16}.
        ///
        /// MSVC allocates bitfields from the least-significant bit, so
        /// cloneGroupId lives in the LOW half and sourceModeInfoIdx in the
        /// HIGH half -- the opposite of how the declaration reads. Verified
        /// against live data on this machine: 0x0001FFFF is clone group 0xFFFF
        /// (none) plus source mode index 1, which resolves to the correct
        /// 3440x1440 @(-3440,0) source. Getting this backwards silently yields
        /// 0x0 geometry rather than an error, which is why it is worth stating.
        /// </summary>
        private static bool TryGetSourceModeIndex(CcdConfig cfg, uint rawIdx, out int index)
        {
            index = -1;

            if ((cfg.QueryFlags & QDC_VIRTUAL_MODE_AWARE) != 0)
            {
                uint high = (rawIdx >> 16) & 0xFFFF;
                if (high == 0xFFFF) { return false; }
                index = (int)high;
            }
            else
            {
                if (rawIdx == INVALID_MODE_INDEX) { return false; }
                index = (int)rawIdx;
            }

            return (index >= 0 && index < cfg.Modes.Length);
        }

        /// <summary>Flatten a config into per-target rows for PowerShell.</summary>
        public static TargetInfo[] ListTargets(CcdConfig cfg)
        {
            List<TargetInfo> list = new List<TargetInfo>();

            for (int i = 0; i < cfg.Paths.Length; i++)
            {
                DISPLAYCONFIG_PATH_INFO p = cfg.Paths[i];

                TargetInfo t = new TargetInfo();
                t.PathIndex = i;
                t.AdapterKey = p.targetInfo.adapterId.ToKey();
                t.TargetId = p.targetInfo.id;
                t.SourceId = p.sourceInfo.id;
                t.Active = (p.flags & DISPLAYCONFIG_PATH_ACTIVE) != 0;
                t.OutputTechnology = p.targetInfo.outputTechnology;
                t.RefreshNumerator = p.targetInfo.refreshRate.Numerator;
                t.RefreshDenominator = p.targetInfo.refreshRate.Denominator;

                string friendly;
                string devPath;
                if (TryGetTargetName(p.targetInfo.adapterId, p.targetInfo.id, out friendly, out devPath))
                {
                    t.FriendlyName = friendly;
                    t.DevicePath = devPath;
                    t.HardwareId = ParseHardwareId(devPath);
                }

                // Resolve the source mode for geometry, when the path is active.
                int mi;
                if (t.Active && TryGetSourceModeIndex(cfg, p.sourceInfo.modeInfoIdx, out mi) &&
                    cfg.Modes[mi].infoType == MODE_INFO_TYPE_SOURCE)
                {
                    DISPLAYCONFIG_SOURCE_MODE sm = cfg.Modes[mi].modeInfo.sourceMode;
                    t.Width = sm.width;
                    t.Height = sm.height;
                    t.PositionX = sm.position.x;
                    t.PositionY = sm.position.y;
                    // Windows defines the primary display as the one whose
                    // source origin is (0,0); everything else is positioned
                    // relative to it.
                    t.IsPrimary = (sm.position.x == 0 && sm.position.y == 0);
                }

                list.Add(t);
            }

            return list.ToArray();
        }

        /// <summary>
        /// Locate a target by EDID hardware id (e.g. "TCL9653").
        /// QDC_ALL_PATHS returns hundreds of candidate paths -- 354 on the
        /// development machine -- and the same monitor legitimately appears on
        /// several of them, so prefer a path that is already active and fall
        /// back to the first inactive match. Returns -1 when not found.
        /// </summary>
        public static int FindPathByHardwareId(CcdConfig cfg, string hardwareId)
        {
            if (string.IsNullOrEmpty(hardwareId)) { return -1; }

            int fallback = -1;

            for (int i = 0; i < cfg.Paths.Length; i++)
            {
                string friendly;
                string devPath;
                if (!TryGetTargetName(cfg.Paths[i].targetInfo.adapterId,
                                      cfg.Paths[i].targetInfo.id, out friendly, out devPath))
                {
                    continue;
                }

                string hw = ParseHardwareId(devPath);
                if (hw == null || !hw.Equals(hardwareId, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                if ((cfg.Paths[i].flags & DISPLAYCONFIG_PATH_ACTIVE) != 0) { return i; }
                if (fallback < 0) { fallback = i; }
            }

            return fallback;
        }

        /// <summary>Count of currently active paths -- cheap drift check.</summary>
        public static int CountActive(CcdConfig cfg)
        {
            int n = 0;
            for (int i = 0; i < cfg.Paths.Length; i++)
            {
                if ((cfg.Paths[i].flags & DISPLAYCONFIG_PATH_ACTIVE) != 0) { n++; }
            }
            return n;
        }

        // ------------------------------------------------------------ apply --

        public static int Apply(DISPLAYCONFIG_PATH_INFO[] paths, DISPLAYCONFIG_MODE_INFO[] modes, uint flags)
        {
            uint pathCount = (paths == null) ? 0 : (uint)paths.Length;
            uint modeCount = (modes == null) ? 0 : (uint)modes.Length;
            return SetDisplayConfig(pathCount, paths, modeCount, modes, flags);
        }

        /// <summary>
        /// Build a topology with exactly one active path (the given path index)
        /// positioned at the origin. Mode indices are set invalid and no mode
        /// array is supplied, so Windows picks valid modes itself under
        /// SDC_ALLOW_CHANGES -- hand-building mode arrays for the enable
        /// direction is unnecessary risk.
        /// </summary>
        public static DISPLAYCONFIG_PATH_INFO[] BuildSingleTargetPaths(CcdConfig all, int pathIndex)
        {
            DISPLAYCONFIG_PATH_INFO p = all.Paths[pathIndex];

            p.flags |= DISPLAYCONFIG_PATH_ACTIVE;
            p.sourceInfo.modeInfoIdx = INVALID_MODE_INDEX;
            p.targetInfo.modeInfoIdx = INVALID_MODE_INDEX;
            p.sourceInfo.statusFlags = 0;
            p.targetInfo.statusFlags = 0;

            return new DISPLAYCONFIG_PATH_INFO[] { p };
        }

        // ------------------------------------------------------ LUID remap --

        /// <summary>
        /// Rewrite every adapterId in a deserialized config to the LUID the
        /// graphics stack is using right now, matched by stable adapter device
        /// path. Returns the number of adapters that could not be resolved --
        /// non-zero means the saved topology refers to hardware that is gone.
        /// </summary>
        public static int RemapAdapterIds(CcdConfig cfg)
        {
            // Current device path -> current LUID.
            CcdConfig current = Query(QDC_ALL_PATHS);
            Dictionary<string, LUID> byPath = new Dictionary<string, LUID>(StringComparer.OrdinalIgnoreCase);

            for (int i = 0; i < current.Paths.Length; i++)
            {
                AddByPath(byPath, current.Paths[i].sourceInfo.adapterId);
                AddByPath(byPath, current.Paths[i].targetInfo.adapterId);
            }

            // Old LUID key -> new LUID.
            Dictionary<ulong, LUID> remap = new Dictionary<ulong, LUID>();
            int unresolved = 0;

            foreach (KeyValuePair<ulong, string> kv in cfg.AdapterPaths)
            {
                if (kv.Value != null && byPath.ContainsKey(kv.Value)) { remap[kv.Key] = byPath[kv.Value]; }
                else { unresolved++; }
            }

            for (int i = 0; i < cfg.Paths.Length; i++)
            {
                cfg.Paths[i].sourceInfo.adapterId = Translate(remap, cfg.Paths[i].sourceInfo.adapterId);
                cfg.Paths[i].targetInfo.adapterId = Translate(remap, cfg.Paths[i].targetInfo.adapterId);
            }
            for (int i = 0; i < cfg.Modes.Length; i++)
            {
                cfg.Modes[i].adapterId = Translate(remap, cfg.Modes[i].adapterId);
            }

            return unresolved;
        }

        private static void AddByPath(Dictionary<string, LUID> map, LUID luid)
        {
            string path = GetAdapterDevicePath(luid);
            if (string.IsNullOrEmpty(path)) { return; }
            if (!map.ContainsKey(path)) { map[path] = luid; }
        }

        private static LUID Translate(Dictionary<ulong, LUID> remap, LUID old)
        {
            ulong key = old.ToKey();
            if (remap.ContainsKey(key)) { return remap[key]; }
            return old;
        }

        // ------------------------------------------------------ serialize ----

        private const uint BLOB_MAGIC   = 0x4443464E; // "NFCD"
        private const int  BLOB_VERSION = 1;

        public static byte[] Serialize(CcdConfig cfg)
        {
            int pathSize = Marshal.SizeOf(typeof(DISPLAYCONFIG_PATH_INFO));
            int modeSize = Marshal.SizeOf(typeof(DISPLAYCONFIG_MODE_INFO));

            using (MemoryStream ms = new MemoryStream())
            using (BinaryWriter w = new BinaryWriter(ms, Encoding.Unicode))
            {
                w.Write(BLOB_MAGIC);
                w.Write(BLOB_VERSION);
                w.Write(cfg.QueryFlags);
                w.Write(pathSize);
                w.Write(modeSize);
                w.Write(cfg.Paths.Length);
                w.Write(cfg.Modes.Length);

                w.Write(StructsToBytes<DISPLAYCONFIG_PATH_INFO>(cfg.Paths));
                w.Write(StructsToBytes<DISPLAYCONFIG_MODE_INFO>(cfg.Modes));

                w.Write(cfg.AdapterPaths.Count);
                foreach (KeyValuePair<ulong, string> kv in cfg.AdapterPaths)
                {
                    w.Write(kv.Key);
                    string v = (kv.Value == null) ? string.Empty : kv.Value;
                    byte[] vb = Encoding.Unicode.GetBytes(v);
                    w.Write(vb.Length);
                    w.Write(vb);
                }

                return ms.ToArray();
            }
        }

        public static CcdConfig Deserialize(byte[] blob)
        {
            using (MemoryStream ms = new MemoryStream(blob))
            using (BinaryReader r = new BinaryReader(ms, Encoding.Unicode))
            {
                uint magic = r.ReadUInt32();
                if (magic != BLOB_MAGIC)
                {
                    throw new InvalidOperationException("Display topology blob has a bad magic number.");
                }

                int version = r.ReadInt32();
                if (version != BLOB_VERSION)
                {
                    throw new InvalidOperationException(
                        "Display topology blob version " + version + " is not supported.");
                }

                CcdConfig cfg = new CcdConfig();
                cfg.QueryFlags = r.ReadUInt32();

                int pathSize = r.ReadInt32();
                int modeSize = r.ReadInt32();

                // Struct sizes are architecture-independent here (no pointers),
                // so a mismatch means the blob is corrupt, not just foreign.
                if (pathSize != Marshal.SizeOf(typeof(DISPLAYCONFIG_PATH_INFO)) ||
                    modeSize != Marshal.SizeOf(typeof(DISPLAYCONFIG_MODE_INFO)))
                {
                    throw new InvalidOperationException("Display topology blob has unexpected struct sizes.");
                }

                int pathCount = r.ReadInt32();
                int modeCount = r.ReadInt32();

                cfg.Paths = BytesToStructs<DISPLAYCONFIG_PATH_INFO>(r.ReadBytes(pathCount * pathSize), pathCount);
                cfg.Modes = BytesToStructs<DISPLAYCONFIG_MODE_INFO>(r.ReadBytes(modeCount * modeSize), modeCount);

                int adapterCount = r.ReadInt32();
                for (int i = 0; i < adapterCount; i++)
                {
                    ulong key = r.ReadUInt64();
                    int len = r.ReadInt32();
                    string val = Encoding.Unicode.GetString(r.ReadBytes(len));
                    cfg.AdapterPaths[key] = val;
                }

                return cfg;
            }
        }

        private static byte[] StructsToBytes<T>(T[] arr) where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            byte[] buf = new byte[size * arr.Length];
            IntPtr p = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < arr.Length; i++)
                {
                    Marshal.StructureToPtr(arr[i], p, false);
                    Marshal.Copy(p, buf, i * size, size);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(p);
            }
            return buf;
        }

        private static T[] BytesToStructs<T>(byte[] buf, int count) where T : struct
        {
            int size = Marshal.SizeOf(typeof(T));
            T[] arr = new T[count];
            IntPtr p = Marshal.AllocHGlobal(size);
            try
            {
                for (int i = 0; i < count; i++)
                {
                    Marshal.Copy(buf, i * size, p, size);
                    arr[i] = (T)Marshal.PtrToStructure(p, typeof(T));
                }
            }
            finally
            {
                Marshal.FreeHGlobal(p);
            }
            return arr;
        }

        public static string Describe(int rc)
        {
            switch (rc)
            {
                case 0:    return "ERROR_SUCCESS";
                case 5:    return "ERROR_ACCESS_DENIED";
                case 87:   return "ERROR_INVALID_PARAMETER";
                case 31:   return "ERROR_GEN_FAILURE";
                case 1004: return "ERROR_INVALID_FLAGS";
                case 1359: return "ERROR_INTERNAL_ERROR";
                case 122:  return "ERROR_INSUFFICIENT_BUFFER";
                case 1450: return "ERROR_NO_SYSTEM_RESOURCES";
                case 1168: return "ERROR_NOT_FOUND";
                default:   return "Win32 error " + rc;
            }
        }
    }
}
