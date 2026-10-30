import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

class Session {
  const Session({required this.baseUrl, required this.token});

  final String baseUrl;
  final String token;
}

class PairResult {
  const PairResult({required this.token, required this.deviceName});

  final String token;
  final String deviceName;
}

class ApiException implements Exception {
  ApiException(this.message, {this.status});

  final String message;
  final int? status;

  @override
  String toString() => message;
}

class UnauthorizedException extends ApiException {
  UnauthorizedException() : super('This phone is no longer paired. Pair it again.', status: 401);
}

class RuntimeInfo {
  const RuntimeInfo({required this.phase, required this.message, this.error});

  final String phase;
  final String message;
  final String? error;

  bool get running => phase == 'running';

  factory RuntimeInfo.fromJson(Map<String, dynamic> json) {
    final error = json['error'];
    return RuntimeInfo(
      phase: _string(json['phase'], 'stopped'),
      message: _string(json['message'], 'Linux is not running'),
      error: error is Map<String, dynamic> ? _string(error['message']) : null,
    );
  }
}

class TaskInfo {
  const TaskInfo({required this.status, this.activity, this.conversationId});

  final String status;
  final String? activity;
  final String? conversationId;

  bool get busy => const {'planning', 'running', 'waiting-approval', 'cancelling'}.contains(status);

  factory TaskInfo.fromJson(Map<String, dynamic> json) {
    return TaskInfo(
      status: _string(json['status'], 'idle'),
      activity: _nullableString(json['activity']),
      conversationId: _nullableString(json['conversationId']),
    );
  }
}

class ApprovalInfo {
  const ApprovalInfo({
    required this.id,
    required this.title,
    required this.reason,
    this.command,
  });

  final String id;
  final String title;
  final String reason;
  final String? command;

  factory ApprovalInfo.fromJson(Map<String, dynamic> json) {
    return ApprovalInfo(
      id: _string(json['id']),
      title: _string(json['title'], 'Confirm this operation'),
      reason: _string(json['reason']),
      command: _nullableString(json['command']),
    );
  }
}

class ToolCallInfo {
  const ToolCallInfo({
    required this.id,
    required this.name,
    required this.title,
    required this.state,
    this.summary,
    this.command,
    this.output,
    this.exitCode,
  });

  final String id;
  final String name;
  final String title;
  final String state;
  final String? summary;
  final String? command;
  final String? output;
  final int? exitCode;

  factory ToolCallInfo.fromJson(Map<String, dynamic> json) {
    final exit = json['exitCode'];
    return ToolCallInfo(
      id: _string(json['id']),
      name: _string(json['name']),
      title: _string(json['title'], _string(json['name'], 'Tool')),
      state: _string(json['state'], 'running'),
      summary: _nullableString(json['summary']),
      command: _nullableString(json['command']),
      output: _nullableString(json['output']),
      exitCode: exit is num ? exit.toInt() : null,
    );
  }
}

class ChatMessageInfo {
  const ChatMessageInfo({
    required this.id,
    required this.role,
    required this.content,
    required this.toolCalls,
    this.error,
    this.cancelled = false,
  });

  final String id;
  final String role;
  final String content;
  final List<ToolCallInfo> toolCalls;
  final String? error;
  final bool cancelled;

  bool get fromUser => role == 'user';

  factory ChatMessageInfo.fromJson(Map<String, dynamic> json) {
    return ChatMessageInfo(
      id: _string(json['id']),
      role: _string(json['role'], 'assistant'),
      content: _string(json['content']),
      error: _nullableString(json['error']),
      cancelled: json['cancelled'] == true,
      toolCalls: _list(json['toolCalls']).map((entry) => ToolCallInfo.fromJson(_map(entry))).toList(),
    );
  }
}

class ConversationInfo {
  const ConversationInfo({
    required this.id,
    required this.title,
    required this.updatedAt,
    required this.messages,
  });

  final String id;
  final String title;
  final int updatedAt;
  final List<ChatMessageInfo> messages;

  factory ConversationInfo.fromJson(Map<String, dynamic> json) {
    return ConversationInfo(
      id: _string(json['id']),
      title: _string(json['title'], 'New task'),
      updatedAt: _int(json['updatedAt']),
      messages: _list(json['messages']).map((entry) => ChatMessageInfo.fromJson(_map(entry))).toList(),
    );
  }
}

class ConversationSummaryInfo {
  const ConversationSummaryInfo({
    required this.id,
    required this.title,
    required this.updatedAt,
    required this.messageCount,
  });

  final String id;
  final String title;
  final int updatedAt;
  final int messageCount;

  factory ConversationSummaryInfo.fromJson(Map<String, dynamic> json) {
    return ConversationSummaryInfo(
      id: _string(json['id']),
      title: _string(json['title'], 'New task'),
      updatedAt: _int(json['updatedAt']),
      messageCount: _int(json['messageCount']),
    );
  }
}

class RemoteState {
  const RemoteState({
    required this.version,
    required this.runtime,
    required this.conversations,
    required this.task,
    this.activeConversationId,
    this.conversation,
    this.approval,
  });

  final String version;
  final RuntimeInfo runtime;
  final List<ConversationSummaryInfo> conversations;
  final TaskInfo task;
  final String? activeConversationId;
  final ConversationInfo? conversation;
  final ApprovalInfo? approval;

  factory RemoteState.fromJson(Map<String, dynamic> json) {
    final conversation = json['conversation'];
    final approval = json['approval'];
    return RemoteState(
      version: _string(json['version']),
      runtime: RuntimeInfo.fromJson(_map(json['runtime'])),
      conversations: _list(json['conversations'])
          .map((entry) => ConversationSummaryInfo.fromJson(_map(entry)))
          .toList(),
      task: TaskInfo.fromJson(_map(json['task'])),
      activeConversationId: _nullableString(json['activeConversationId']),
      conversation: conversation is Map<String, dynamic> ? ConversationInfo.fromJson(conversation) : null,
      approval: approval is Map<String, dynamic> ? ApprovalInfo.fromJson(approval) : null,
    );
  }
}

class ApiClient {
  ApiClient({required this.baseUrl, this.token});

  final String baseUrl;
  String? token;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  Map<String, String> get _headers {
    final current = token;
    return {
      'Content-Type': 'application/json',
      ...?(current == null ? null : {'Authorization': 'Bearer $current'}),
    };
  }

  Future<RemoteState> fetchState() async {
    final data = await _request(() => http.get(_uri('/api/state'), headers: _headers));
    return RemoteState.fromJson(_map(data));
  }

  Future<void> send(String text, {String? conversationId}) async {
    await _request(
      () => http.post(
        _uri('/api/send'),
        headers: _headers,
        body: jsonEncode({
          'text': text,
          'conversationId': ?conversationId,
        }),
      ),
    );
  }

  Future<void> cancel() async {
    await _request(() => http.post(_uri('/api/cancel'), headers: _headers));
  }

  Future<void> approve(String requestId, bool approved) async {
    await _request(
      () => http.post(
        _uri('/api/approve'),
        headers: _headers,
        body: jsonEncode({'requestId': requestId, 'approved': approved}),
      ),
    );
  }

  Future<void> retry(String conversationId) async {
    await _request(
      () => http.post(
        _uri('/api/retry'),
        headers: _headers,
        body: jsonEncode({'conversationId': conversationId}),
      ),
    );
  }

  Future<void> newConversation() async {
    await _request(() => http.post(_uri('/api/conversations/new'), headers: _headers));
  }

  Future<void> selectConversation(String id) async {
    await _request(
      () => http.post(
        _uri('/api/conversations/select'),
        headers: _headers,
        body: jsonEncode({'id': id}),
      ),
    );
  }

  Future<void> startLinux() async {
    await _request(() => http.post(_uri('/api/runtime/start'), headers: _headers));
  }

  Future<void> stopLinux() async {
    await _request(() => http.post(_uri('/api/runtime/stop'), headers: _headers));
  }

  Future<void> forgetDevice() async {
    await _request(() => http.post(_uri('/api/device/forget'), headers: _headers));
  }

  Future<dynamic> _request(Future<http.Response> Function() send) async {
    late http.Response response;
    try {
      response = await send().timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw ApiException('The computer did not answer. Check that TagNest is running and the address is reachable.');
    } on http.ClientException catch (error) {
      throw ApiException('Cannot reach the computer: ${error.message}');
    }
    Map<String, dynamic> data = {};
    if (response.body.isNotEmpty) {
      try {
        final decoded = jsonDecode(response.body);
        if (decoded is Map<String, dynamic>) data = decoded;
      } catch (_) {
        // A proxy may return HTML for a bad address; keep a useful message.
      }
    }
    if (response.statusCode == 401) throw UnauthorizedException();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(
        _string(data['error'], 'Request failed (${response.statusCode})'),
        status: response.statusCode,
      );
    }
    return data;
  }

  static Future<PairResult> pair({
    required String baseUrl,
    required String code,
    required String deviceName,
  }) async {
    late http.Response response;
    try {
      response = await http
          .post(
            Uri.parse('$baseUrl/api/pair'),
            headers: const {
              'Content-Type': 'application/json',
              'X-TagNest-Native': '1',
            },
            body: jsonEncode({'code': code, 'name': deviceName}),
          )
          .timeout(const Duration(seconds: 20));
    } on TimeoutException {
      throw ApiException('The computer did not answer. Check the address and that phone access is running.');
    } on http.ClientException catch (error) {
      throw ApiException('Cannot reach the computer: ${error.message}');
    }
    Map<String, dynamic> data = {};
    try {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) data = decoded;
    } catch (_) {
      // handled below
    }
    if (response.statusCode == 401) {
      throw ApiException('That pairing code is wrong or has expired.');
    }
    if (response.statusCode == 429) {
      throw ApiException('Too many attempts. Wait a few minutes and try again.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(_string(data['error'], 'Pairing failed (${response.statusCode})'));
    }
    final token = _nullableString(data['token']);
    if (token == null || token.isEmpty) {
      throw ApiException('The computer did not return a device token. Update TagNest on the computer and try again.');
    }
    final device = _map(data['device']);
    return PairResult(token: token, deviceName: _string(device['name'], deviceName));
  }
}

class SessionStore {
  static const _serverKey = 'tagnest.server';
  static const _tokenKey = 'tagnest.token';

  static Future<Session?> load() async {
    final prefs = await SharedPreferences.getInstance();
    final server = prefs.getString(_serverKey);
    final token = prefs.getString(_tokenKey);
    if (server == null || token == null || server.isEmpty || token.isEmpty) return null;
    return Session(baseUrl: server, token: token);
  }

  static Future<String?> lastServer() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_serverKey);
  }

  static Future<void> save(Session session) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_serverKey, session.baseUrl);
    await prefs.setString(_tokenKey, session.token);
  }

  static Future<void> clear() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_tokenKey);
  }
}

String normalizeServerInput(String input) {
  var value = input.trim();
  if (value.isEmpty) throw ApiException('Enter the address shown in TagNest on the computer.');
  if (!value.startsWith('http://') && !value.startsWith('https://')) {
    value = 'https://$value';
  }
  final uri = Uri.tryParse(value);
  if (uri == null || uri.host.isEmpty) {
    throw ApiException('That address is not valid. Example: https://example.trycloudflare.com');
  }
  if (uri.path.isNotEmpty && uri.path != '/') {
    throw ApiException('Use only the address, without a path.');
  }
  return uri.replace(path: '', query: null, fragment: null).toString().replaceAll(RegExp(r'/$'), '');
}

String _string(Object? value, [String fallback = '']) {
  if (value is String) return value;
  if (value == null) return fallback;
  return value.toString();
}

String? _nullableString(Object? value) {
  if (value is String && value.isNotEmpty) return value;
  return null;
}

int _int(Object? value) {
  if (value is num) return value.toInt();
  return int.tryParse(value?.toString() ?? '') ?? 0;
}

List<dynamic> _list(Object? value) => value is List ? value : const [];

Map<String, dynamic> _map(Object? value) => value is Map<String, dynamic> ? value : <String, dynamic>{};
