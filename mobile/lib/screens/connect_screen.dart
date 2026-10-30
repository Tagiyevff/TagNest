import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api.dart';
import '../theme.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.onConnected, this.lastServer});

  final ValueChanged<Session> onConnected;
  final String? lastServer;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  late final TextEditingController _server = TextEditingController(text: widget.lastServer ?? '');
  final TextEditingController _code = TextEditingController();
  final TextEditingController _name = TextEditingController(text: 'My phone');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _server.dispose();
    _code.dispose();
    _name.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    FocusScope.of(context).unfocus();
    setState(() => _error = null);
    final code = _code.text.trim();
    if (code.length != 6) {
      setState(() => _error = 'Enter the 6-digit code shown in TagNest on the computer.');
      return;
    }
    setState(() => _busy = true);
    try {
      final baseUrl = normalizeServerInput(_server.text);
      final result = await ApiClient.pair(
        baseUrl: baseUrl,
        code: code,
        deviceName: _name.text.trim().isEmpty ? 'Phone' : _name.text.trim(),
      );
      final session = Session(baseUrl: baseUrl, token: result.token);
      await SessionStore.save(session);
      if (!mounted) return;
      widget.onConnected(session);
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.message);
    } catch (error) {
      if (mounted) setState(() => _error = error.toString());
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(22, 28, 22, 28),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 460),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Align(
                    alignment: Alignment.centerLeft,
                    child: Container(
                      width: 46,
                      height: 46,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: AppColors.accent,
                        borderRadius: BorderRadius.circular(14),
                      ),
                      child: const Text(
                        'T',
                        style: TextStyle(
                          color: Color(0xFFF3F6F8),
                          fontSize: 23,
                          fontWeight: FontWeight.w800,
                          letterSpacing: -1,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 18),
                  const Text(
                    'TagNest',
                    style: TextStyle(fontSize: 30, fontWeight: FontWeight.w700, letterSpacing: -1.1),
                  ),
                  const SizedBox(height: 5),
                  const Text(
                    'Your AI workspace, now on this phone.',
                    style: TextStyle(color: AppColors.ink2, fontSize: 14),
                  ),
                  const SizedBox(height: 26),
                  _label('Computer address'),
                  TextField(
                    controller: _server,
                    keyboardType: TextInputType.url,
                    autocorrect: false,
                    enableSuggestions: false,
                    textInputAction: TextInputAction.next,
                    decoration: const InputDecoration(
                      hintText: 'https://example.trycloudflare.com',
                    ),
                  ),
                  const SizedBox(height: 15),
                  _label('Pairing code'),
                  TextField(
                    controller: _code,
                    keyboardType: TextInputType.number,
                    textInputAction: TextInputAction.next,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly, LengthLimitingTextInputFormatter(6)],
                    style: const TextStyle(fontSize: 24, letterSpacing: 6, fontWeight: FontWeight.w600),
                    textAlign: TextAlign.center,
                    decoration: const InputDecoration(hintText: '000000'),
                  ),
                  const SizedBox(height: 15),
                  _label('This phone'),
                  TextField(
                    controller: _name,
                    textInputAction: TextInputAction.done,
                    maxLength: 40,
                    onSubmitted: (_) => _pair(),
                    decoration: const InputDecoration(hintText: 'My phone', counterText: ''),
                  ),
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _pair,
                    child: _busy
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : const Text('Pair this phone'),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 14),
                    Container(
                      padding: const EdgeInsets.all(11),
                      decoration: BoxDecoration(
                        color: AppColors.err.withValues(alpha: 0.07),
                        borderRadius: BorderRadius.circular(10),
                        border: Border.all(color: AppColors.err.withValues(alpha: 0.2)),
                      ),
                      child: Text(
                        _error!,
                        style: const TextStyle(color: AppColors.err, fontSize: 12, height: 1.4),
                      ),
                    ),
                  ],
                  const SizedBox(height: 22),
                  const Text(
                    'In TagNest on the computer, open Settings → Phone access, start it, then enter the 6-digit '
                    'pairing code here. The code expires after 15 minutes.',
                    style: TextStyle(color: AppColors.ink3, fontSize: 11.5, height: 1.55),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _label(String text) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6, left: 2),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          color: AppColors.ink2,
          fontSize: 10,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.8,
        ),
      ),
    );
  }
}
