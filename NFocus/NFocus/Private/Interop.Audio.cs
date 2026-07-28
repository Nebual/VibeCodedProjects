// Interop.Audio.cs -- Core Audio per-application mute.
//
// Used to silence Discord locally. Discord exposes no sanctioned way to set
// your own status (bots cannot, and OAuth2 has no scope for it); the only
// reliable method is a user token, which is self-botting and risks the account.
// So we leave the status alone and just mute the app.
//
// VTABLE ORDER IS LOAD-BEARING. COM dispatches by slot, not by name, so every
// inherited method must be re-declared in order before the derived ones. Get
// one wrong and you silently call the neighbouring method.
//
// Deliberately NOT done via the registry: HKCU\...\PolicyConfig\PropertyStore
// holds thousands of entries keyed per endpoint x exe path x app version, it is
// undocumented and cached, and Discord's path changes on every self-update.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NFocus
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
        [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr pClient);
        [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceCollection
    {
        [PreserveSig] int GetCount(out uint pcDevices);
        [PreserveSig] int Item(uint nDevice, out IMMDevice ppDevice);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams,
                                   [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IntPtr ppProperties);
        [PreserveSig] int GetId(out IntPtr ppstrId);
        [PreserveSig] int GetState(out uint pdwState);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        // --- IAudioSessionManager (slots 0-1) ---
        [PreserveSig] int GetAudioSessionControl(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr SessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint StreamFlags, out IntPtr AudioVolume);
        // --- IAudioSessionManager2 (slots 2+) ---
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        [PreserveSig] int RegisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int UnregisterSessionNotification(IntPtr SessionNotification);
        [PreserveSig] int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionID, IntPtr duckNotification);
        [PreserveSig] int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int SessionCount);
        [PreserveSig] int GetSession(int SessionIndex, out IAudioSessionControl2 Session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl2
    {
        // --- IAudioSessionControl (slots 0-8) ---
        [PreserveSig] int GetState(out int pRetVal);
        [PreserveSig] int GetDisplayName(out IntPtr pRetVal);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, IntPtr EventContext);
        [PreserveSig] int GetIconPath(out IntPtr pRetVal);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, IntPtr EventContext);
        [PreserveSig] int GetGroupingParam(out Guid pRetVal);
        [PreserveSig] int SetGroupingParam(ref Guid Override, IntPtr EventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr NewNotifications);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        // --- IAudioSessionControl2 (slots 9+) ---
        [PreserveSig] int GetSessionIdentifier(out IntPtr pRetVal);
        [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr pRetVal);
        [PreserveSig] int GetProcessId(out uint pRetVal);
        [PreserveSig] int IsSystemSoundsSession();
        [PreserveSig] int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float fLevel, IntPtr EventContext);
        [PreserveSig] int GetMasterVolume(out float pfLevel);
        [PreserveSig] int SetMute(bool bMute, IntPtr EventContext);
        [PreserveSig] int GetMute(out bool pbMute);
    }

    public class AudioSessionInfo
    {
        public uint ProcessId;
        public string ProcessName;
        public string ExePath;
        public string EndpointId;
        public bool Muted;
        public float Volume;
        public int State;          // 0 Inactive, 1 Active, 2 Expired
        public bool IsSystemSounds;
    }

    public static class AudioSessions
    {
        private const int  E_DATA_FLOW_RENDER   = 0;
        private const int  DEVICE_STATE_ACTIVE  = 0x00000001;
        private const uint CLSCTX_ALL           = 23;
        private const int  S_OK                 = 0;

        private static readonly Guid IID_IAudioSessionManager2 =
            new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

        /// <summary>
        /// Snapshot every session on every ACTIVE render endpoint -- not just
        /// the default one. Discord can hold sessions on endpoints that are not
        /// currently the default, and those would otherwise stay audible.
        /// </summary>
        public static AudioSessionInfo[] List()
        {
            List<AudioSessionInfo> results = new List<AudioSessionInfo>();

            IMMDeviceEnumerator enumerator =
                (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());

            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(E_DATA_FLOW_RENDER, DEVICE_STATE_ACTIVE, out devices) != S_OK)
            {
                return results.ToArray();
            }

            uint deviceCount;
            if (devices.GetCount(out deviceCount) != S_OK) { return results.ToArray(); }

            for (uint d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) != S_OK || device == null) { continue; }

                string endpointId = GetDeviceId(device);

                object rawManager;
                Guid iid = IID_IAudioSessionManager2;
                if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out rawManager) != S_OK ||
                    rawManager == null)
                {
                    continue;
                }

                IAudioSessionManager2 manager = rawManager as IAudioSessionManager2;
                if (manager == null) { continue; }

                IAudioSessionEnumerator sessions;
                if (manager.GetSessionEnumerator(out sessions) != S_OK || sessions == null) { continue; }

                int sessionCount;
                if (sessions.GetCount(out sessionCount) != S_OK) { continue; }

                for (int i = 0; i < sessionCount; i++)
                {
                    IAudioSessionControl2 ctl;
                    if (sessions.GetSession(i, out ctl) != S_OK || ctl == null) { continue; }

                    AudioSessionInfo info = new AudioSessionInfo();
                    info.EndpointId = endpointId;
                    info.IsSystemSounds = (ctl.IsSystemSoundsSession() == S_OK);

                    uint pid;
                    if (ctl.GetProcessId(out pid) != S_OK) { pid = 0; }
                    info.ProcessId = pid;

                    int state;
                    if (ctl.GetState(out state) == S_OK) { info.State = state; }

                    FillProcessDetails(info);

                    ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
                    if (vol != null)
                    {
                        bool muted;
                        if (vol.GetMute(out muted) == S_OK) { info.Muted = muted; }
                        float level;
                        if (vol.GetMasterVolume(out level) == S_OK) { info.Volume = level; }
                    }

                    results.Add(info);
                }
            }

            return results.ToArray();
        }

        /// <summary>
        /// Set mute on every session owned by one of the given PIDs. Returns
        /// the count of sessions actually changed (already-correct sessions are
        /// left alone so the caller can distinguish "we did it" from "it was
        /// already so").
        /// </summary>
        public static int SetMuteForPids(uint[] pids, bool mute)
        {
            if (pids == null || pids.Length == 0) { return 0; }

            HashSet<uint> wanted = new HashSet<uint>();
            for (int i = 0; i < pids.Length; i++) { wanted.Add(pids[i]); }

            int changed = 0;

            IMMDeviceEnumerator enumerator =
                (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());

            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(E_DATA_FLOW_RENDER, DEVICE_STATE_ACTIVE, out devices) != S_OK)
            {
                return 0;
            }

            uint deviceCount;
            if (devices.GetCount(out deviceCount) != S_OK) { return 0; }

            for (uint d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) != S_OK || device == null) { continue; }

                object rawManager;
                Guid iid = IID_IAudioSessionManager2;
                if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out rawManager) != S_OK ||
                    rawManager == null)
                {
                    continue;
                }

                IAudioSessionManager2 manager = rawManager as IAudioSessionManager2;
                if (manager == null) { continue; }

                IAudioSessionEnumerator sessions;
                if (manager.GetSessionEnumerator(out sessions) != S_OK || sessions == null) { continue; }

                int sessionCount;
                if (sessions.GetCount(out sessionCount) != S_OK) { continue; }

                for (int i = 0; i < sessionCount; i++)
                {
                    IAudioSessionControl2 ctl;
                    if (sessions.GetSession(i, out ctl) != S_OK || ctl == null) { continue; }

                    uint pid;
                    if (ctl.GetProcessId(out pid) != S_OK) { continue; }
                    if (!wanted.Contains(pid)) { continue; }

                    ISimpleAudioVolume vol = ctl as ISimpleAudioVolume;
                    if (vol == null) { continue; }

                    bool current;
                    if (vol.GetMute(out current) == S_OK && current == mute) { continue; }

                    if (vol.SetMute(mute, IntPtr.Zero) == S_OK) { changed++; }
                }
            }

            return changed;
        }

        private static string GetDeviceId(IMMDevice device)
        {
            IntPtr p = IntPtr.Zero;
            try
            {
                if (device.GetId(out p) != S_OK || p == IntPtr.Zero) { return null; }
                return Marshal.PtrToStringUni(p);
            }
            finally
            {
                if (p != IntPtr.Zero) { Marshal.FreeCoTaskMem(p); }
            }
        }

        private static void FillProcessDetails(AudioSessionInfo info)
        {
            if (info.ProcessId == 0) { info.ProcessName = "System"; return; }

            try
            {
                Process p = Process.GetProcessById((int)info.ProcessId);
                info.ProcessName = p.ProcessName;
                try
                {
                    // Throws for protected or cross-session processes. The name
                    // alone is enough to match on, so a failure here is fine.
                    info.ExePath = p.MainModule.FileName;
                }
                catch
                {
                    info.ExePath = null;
                }
            }
            catch
            {
                // Session outlived its process.
                info.ProcessName = null;
            }
        }
    }
}
