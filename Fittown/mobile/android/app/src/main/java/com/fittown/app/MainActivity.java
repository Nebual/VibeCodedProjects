package com.fittown.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Must be registered before super.onCreate() — that's where Capacitor
    // builds the bridge and hands plugins to the WebView.
    registerPlugin(DeviceTokenPlugin.class);
    super.onCreate(savedInstanceState);
  }
}
