package com.astha.companion;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.regex.Pattern;

/**
 * The remembered ASTHA ClipCam for one profile. The whole record, pairing code included, is
 * sealed before it reaches app-private storage; the key is supplied by {@link Crypto} (an
 * Android Keystore key in the app, a software key in unit tests). Nothing is logged, and
 * errors carry only a fixed code, never record contents.
 */
final class CameraPairingVault {
    interface Crypto {
        byte[] seal(byte[] plain, byte[] associated) throws GeneralSecurityException;
        byte[] open(byte[] sealed, byte[] associated) throws GeneralSecurityException;
    }

    interface Storage {
        String get(String key);
        void put(String key, String value);
        void remove(String key);
    }

    static final class Failure extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;

        Failure(String code) {
            super(code);
            this.code = code;
        }
    }

    static final class Record {
        String origin;
        String token;
        List<String> fallbacks = new ArrayList<>();
        String deviceId;
        String deviceName;
        String model;
        String backend;
        boolean proof;
        boolean autoConnect = true;
    }

    // Only encrypted bytes cross the bridge in a rollback receipt. Comparing the complete
    // new ciphertext makes compensation conditional: it cannot undo a later successful save.
    static final class WriteReceipt {
        final String before;
        final String after;
        WriteReceipt(String before, String after) { this.before = before; this.after = after; }
    }

    static final int MAX_FALLBACKS = 4;
    private static final Pattern PROFILE = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final Pattern ORIGIN = Pattern.compile("https://[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[1-9][0-9]{0,4})?");
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{43,128}");
    private static final Pattern DEVICE_ID = Pattern.compile("[A-Za-z0-9_-]{16,64}");
    private static final Pattern HOST_LABEL = Pattern.compile("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?");
    private static final String PREFIX = "kit.";

    private final Storage storage;
    private final Crypto crypto;

    CameraPairingVault(Storage storage, Crypto crypto) {
        this.storage = storage;
        this.crypto = crypto;
    }

    static String profile(String value) throws Failure {
        if (value == null || !PROFILE.matcher(value).matches()) throw new Failure("invalid_profile");
        return value;
    }

    static String origin(String value) throws Failure {
        if (value == null || value.length() > 270 || !ORIGIN.matcher(value).matches()) throw new Failure("invalid_pairing");
        int colon = value.indexOf(':', "https://".length());
        if (colon >= 0 && Integer.parseInt(value.substring(colon + 1)) > 65535) throw new Failure("invalid_pairing");
        return value;
    }

    static String printable(String value) {
        if (value == null) return null;
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < value.length() && text.length() < 80; i++) {
            char c = value.charAt(i);
            if (c >= 0x20 && c <= 0x7e) text.append(c);
        }
        return text.toString();
    }

    /** Checks every field the same way the web store does; unknown or malformed values are refused. */
    static Record checked(Record input) throws Failure {
        if (input == null || input.token == null || !TOKEN.matcher(input.token).matches()) throw new Failure("invalid_pairing");
        Record record = new Record();
        record.origin = origin(input.origin);
        record.token = input.token;
        for (String fallback : input.fallbacks == null ? Collections.<String>emptyList() : input.fallbacks) {
            String value = origin(fallback);
            if (!value.equals(record.origin) && !record.fallbacks.contains(value) && record.fallbacks.size() < MAX_FALLBACKS) record.fallbacks.add(value);
        }
        record.deviceId = input.deviceId != null && DEVICE_ID.matcher(input.deviceId).matches() ? input.deviceId : null;
        record.deviceName = input.deviceName != null && HOST_LABEL.matcher(input.deviceName).matches() ? input.deviceName : null;
        record.model = printable(input.model);
        record.backend = printable(input.backend);
        record.proof = input.proof;
        record.autoConnect = input.autoConnect;
        return record;
    }

    // One "name=value" line per field. Every value is printable ASCII without line breaks.
    static String encode(Record record) {
        StringBuilder text = new StringBuilder("v=1\n");
        line(text, "origin", record.origin);
        line(text, "token", record.token);
        line(text, "fallbacks", String.join(" ", record.fallbacks));
        line(text, "id", record.deviceId);
        line(text, "name", record.deviceName);
        line(text, "model", record.model);
        line(text, "backend", record.backend);
        line(text, "proof", record.proof ? "1" : "0");
        line(text, "auto", record.autoConnect ? "1" : "0");
        return text.toString();
    }

    private static void line(StringBuilder text, String name, String value) {
        if (value != null) text.append(name).append('=').append(value).append('\n');
    }

    static Record decode(String text) throws Failure {
        if (text == null || !text.startsWith("v=1\n")) throw new Failure("invalid_record");
        Record record = new Record();
        for (String line : text.split("\n")) {
            int equals = line.indexOf('=');
            if (equals < 1) throw new Failure("invalid_record");
            String name = line.substring(0, equals), value = line.substring(equals + 1);
            switch (name) {
                case "v": break;
                case "origin": record.origin = value; break;
                case "token": record.token = value; break;
                case "fallbacks":
                    for (String item : value.split(" ")) if (!item.isEmpty()) record.fallbacks.add(item);
                    break;
                case "id": record.deviceId = value; break;
                case "name": record.deviceName = value; break;
                case "model": record.model = value; break;
                case "backend": record.backend = value; break;
                case "proof": record.proof = "1".equals(value); break;
                case "auto": record.autoConnect = "1".equals(value); break;
                default: throw new Failure("invalid_record");
            }
        }
        try { return checked(record); } catch (Failure invalid) { throw new Failure("invalid_record"); }
    }

    private static byte[] associated(String profile) {
        return ("astha.paired-camera.v1\n" + profile).getBytes(StandardCharsets.US_ASCII);
    }

    static String hex(byte[] bytes) {
        char[] digits = "0123456789abcdef".toCharArray();
        char[] text = new char[bytes.length * 2];
        for (int i = 0; i < bytes.length; i++) {
            text[i * 2] = digits[(bytes[i] >> 4) & 15];
            text[i * 2 + 1] = digits[bytes[i] & 15];
        }
        return new String(text);
    }

    static byte[] unhex(String text) throws Failure {
        if (text == null || text.length() % 2 != 0 || text.length() > 8192) throw new Failure("invalid_record");
        byte[] bytes = new byte[text.length() / 2];
        for (int i = 0; i < bytes.length; i++) {
            int high = Character.digit(text.charAt(i * 2), 16), low = Character.digit(text.charAt(i * 2 + 1), 16);
            if (high < 0 || low < 0) throw new Failure("invalid_record");
            bytes[i] = (byte) (high * 16 + low);
        }
        return bytes;
    }

    synchronized WriteReceipt saveReversible(String profile, Record input) throws Failure {
        String id = profile(profile);
        Record record = checked(input);
        byte[] plain = encode(record).getBytes(StandardCharsets.US_ASCII);
        try {
            String before = storage.get(PREFIX + id);
            String after = hex(crypto.seal(plain, associated(id)));
            storage.put(PREFIX + id, after);
            return new WriteReceipt(before, after);
        } catch (GeneralSecurityException | RuntimeException refused) {
            throw new Failure("storage_failed");
        } finally {
            java.util.Arrays.fill(plain, (byte) 0);
        }
    }

    synchronized void save(String profile, Record input) throws Failure {
        saveReversible(profile, input);
    }

    synchronized boolean rollback(String profile, WriteReceipt receipt) throws Failure {
        String id = profile(profile);
        if (receipt == null || receipt.after == null) throw new Failure("invalid_record");
        unhex(receipt.after);
        if (receipt.before != null) unhex(receipt.before);
        try {
            if (!receipt.after.equals(storage.get(PREFIX + id))) return false;
            if (receipt.before == null) storage.remove(PREFIX + id);
            else storage.put(PREFIX + id, receipt.before);
            return true;
        } catch (RuntimeException refused) { throw new Failure("storage_failed"); }
    }

    /** The record, or null when none is remembered. A record that cannot be opened is removed. */
    synchronized Record load(String profile) throws Failure {
        String id = profile(profile);
        String stored = storage.get(PREFIX + id);
        if (stored == null) return null;
        byte[] plain = null;
        try {
            plain = crypto.open(unhex(stored), associated(id));
            return decode(new String(plain, StandardCharsets.US_ASCII));
        } catch (GeneralSecurityException | Failure | RuntimeException unreadable) {
            // A lost Keystore key (for example after a device reset) or a damaged record
            // cannot be repaired; forgetting it lets the user pair again cleanly.
            try { storage.remove(PREFIX + id); }
            catch (RuntimeException refused) { throw new Failure("storage_failed"); }
            throw new Failure("decrypt_failed");
        } finally {
            if (plain != null) java.util.Arrays.fill(plain, (byte) 0);
        }
    }

    synchronized void forget(String profile) throws Failure {
        String id = profile(profile);
        try { storage.remove(PREFIX + id); }
        catch (RuntimeException refused) { throw new Failure("storage_failed"); }
    }
}
