import 'package:flutter/material.dart';

import 'api.dart';
import 'screens/connect_screen.dart';
import 'screens/home_screen.dart';
import 'theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final session = await SessionStore.load();
  final lastServer = await SessionStore.lastServer();
  runApp(TagNestApp(initialSession: session, lastServer: lastServer));
}

class TagNestApp extends StatefulWidget {
  const TagNestApp({super.key, this.initialSession, this.lastServer});

  final Session? initialSession;
  final String? lastServer;

  @override
  State<TagNestApp> createState() => _TagNestAppState();
}

class _TagNestAppState extends State<TagNestApp> {
  Session? _session;
  String? _lastServer;

  @override
  void initState() {
    super.initState();
    _session = widget.initialSession;
    _lastServer = widget.lastServer;
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'TagNest',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      home: _session == null
          ? ConnectScreen(
              lastServer: _lastServer,
              onConnected: (session) => setState(() {
                _session = session;
                _lastServer = session.baseUrl;
              }),
            )
          : HomeScreen(
              key: ValueKey(_session!.baseUrl),
              session: _session!,
              onSessionLost: () {
                SessionStore.clear();
                setState(() => _session = null);
              },
            ),
    );
  }
}
