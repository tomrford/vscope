/**
 * @file vscope.c
 * @brief VScope - Virtual oscilloscope for embedded microcontrollers.
 *
 * Provides data acquisition, real-time buffering, and snapshot storage
 * for debugging and visualization of embedded system variables.
 *
 * @copyright Copyright (c) 2026 Tom Ford
 */

#include "vscope.h"

#include <stdbool.h>
#include <string.h>

#define VSCOPE_MAX_PAYLOAD 252
#define VSCOPE_MAX_VARIABLES 32
#define VSCOPE_NUM_CHANNELS 5
#define VSCOPE_NAME_LEN 16
#define VSCOPE_BUFFER_SIZE 1000
#define VSCOPE_FRAME_TIMEOUT_US 10000
#define VSCOPE_RT_BUFFER_LEN 16
#define VSCOPE_SYNC_BYTE (uint8_t)(0xC8)

// State enum for the state machine in the ISR function
typedef enum {
    VSCOPE_HALTED = 0,
    VSCOPE_RUNNING = 1,
    VSCOPE_ACQUIRING = 2,
    VSCOPE_MISCONFIGURED = 3,
} VscopeState;

// Trigger mode enum
typedef enum {
    VSCOPE_TRG_DISABLED = 0,
    VSCOPE_TRG_RISING = 1,
    VSCOPE_TRG_FALLING = 2,
    VSCOPE_TRG_BOTH = 3,
} VscopeTriggerMode;

// Error codes
typedef enum {
    VSCOPE_ERR_BAD_LEN = 1,
    VSCOPE_ERR_BAD_PARAM = 2,
    VSCOPE_ERR_RANGE = 4,
    VSCOPE_ERR_NOT_READY = 5,
} VscopeStatus;

// Message types
typedef enum {
    VSCOPE_MSG_GET_INFO = 0x01,
    VSCOPE_MSG_GET_TIMING = 0x02,
    VSCOPE_MSG_SET_TIMING = 0x03,
    VSCOPE_MSG_GET_STATE = 0x04,
    VSCOPE_MSG_SET_STATE = 0x05,
    VSCOPE_MSG_TRIGGER = 0x06,
    VSCOPE_MSG_GET_FRAME = 0x07,
    VSCOPE_MSG_GET_SNAPSHOT_HEADER = 0x08,
    VSCOPE_MSG_GET_SNAPSHOT_DATA = 0x09,
    VSCOPE_MSG_GET_VAR_LIST = 0x0A,
    VSCOPE_MSG_GET_CHANNEL_MAP = 0x0B,
    VSCOPE_MSG_SET_CHANNEL_MAP = 0x0C,
    VSCOPE_MSG_GET_RT_LABELS = 0x0D,
    VSCOPE_MSG_GET_RT_BUFFER = 0x0E,
    VSCOPE_MSG_SET_RT_BUFFER = 0x0F,
    VSCOPE_MSG_GET_TRIGGER = 0x10,
    VSCOPE_MSG_SET_TRIGGER = 0x11,
    VSCOPE_MSG_ERROR = 0xFF,
} VscopeMessageType;

// RX state machine states
typedef enum {
    VS_RX_IDLE = 0,
    VS_RX_LEN = 1,
    VS_RX_DATA = 2,
} VscopeRxState;

// Variable struct
typedef struct {
    char name[VSCOPE_NAME_LEN];
    volatile float* ptr;
} VscopeVar;

// Snapshot metadata struct
typedef struct {
    uint32_t divider;
    uint32_t pre_trig;
    uint8_t channel_map[VSCOPE_NUM_CHANNELS];
    float trigger_threshold;
    uint8_t trigger_channel;
    uint8_t trigger_mode;
} VscopeSnapshotMeta;

// State + configuration
static VscopeState vscope_state;
static VscopeState vscope_request;
static uint16_t vscope_isr_khz;
static char vscope_device_name[VSCOPE_NAME_LEN];
static uint8_t vscope_endianness;

// Timing + acquisition counters
static uint32_t vscope_divider;
static uint32_t vscope_pre_trig;
static uint32_t vscope_acq_time;
static uint32_t vscope_index;
static uint32_t vscope_first_element;

// Trigger configuration
static float vscope_trigger_threshold;
static uint8_t vscope_trigger_channel;
static VscopeTriggerMode vscope_trigger_mode;
static bool trigger_invalid;

// Variable registry + channel map
static VscopeVar var_catalog[VSCOPE_MAX_VARIABLES];
static uint8_t var_count;
static bool registration_locked;
static uint8_t channel_map[VSCOPE_NUM_CHANNELS];

// Frame + capture buffers
static volatile float* vscope_frame[VSCOPE_NUM_CHANNELS];
static float vscope_buffer[VSCOPE_BUFFER_SIZE][VSCOPE_NUM_CHANNELS];

// RT buffers
static volatile float* rt_values[VSCOPE_RT_BUFFER_LEN];
static char rt_names[VSCOPE_RT_BUFFER_LEN][VSCOPE_NAME_LEN];
static uint8_t rt_count;

// Snapshot data
static VscopeSnapshotMeta snapshot_meta;
static float snapshot_rt_values[VSCOPE_RT_BUFFER_LEN];
static bool snapshot_valid;

// RX state
static VscopeRxState rx_state;
static uint16_t rx_expected_len;
static uint16_t rx_index;
static uint64_t rx_last_us;
static uint8_t rx_buf[VSCOPE_MAX_PAYLOAD + 2];

//*********************************************************
// Helper Functions
//*********************************************************

// CRC8 lookup table
static const uint8_t crc8_lut[256] = {
    0x00, 0xD5, 0x7F, 0xAA, 0xFE, 0x2B, 0x81, 0x54, 0x29, 0xFC, 0x56, 0x83, 0xD7, 0x02, 0xA8, 0x7D, 0x52, 0x87, 0x2D, 0xF8, 0xAC, 0x79,
    0xD3, 0x06, 0x7B, 0xAE, 0x04, 0xD1, 0x85, 0x50, 0xFA, 0x2F, 0xA4, 0x71, 0xDB, 0x0E, 0x5A, 0x8F, 0x25, 0xF0, 0x8D, 0x58, 0xF2, 0x27,
    0x73, 0xA6, 0x0C, 0xD9, 0xF6, 0x23, 0x89, 0x5C, 0x08, 0xDD, 0x77, 0xA2, 0xDF, 0x0A, 0xA0, 0x75, 0x21, 0xF4, 0x5E, 0x8B, 0x9D, 0x48,
    0xE2, 0x37, 0x63, 0xB6, 0x1C, 0xC9, 0xB4, 0x61, 0xCB, 0x1E, 0x4A, 0x9F, 0x35, 0xE0, 0xCF, 0x1A, 0xB0, 0x65, 0x31, 0xE4, 0x4E, 0x9B,
    0xE6, 0x33, 0x99, 0x4C, 0x18, 0xCD, 0x67, 0xB2, 0x39, 0xEC, 0x46, 0x93, 0xC7, 0x12, 0xB8, 0x6D, 0x10, 0xC5, 0x6F, 0xBA, 0xEE, 0x3B,
    0x91, 0x44, 0x6B, 0xBE, 0x14, 0xC1, 0x95, 0x40, 0xEA, 0x3F, 0x42, 0x97, 0x3D, 0xE8, 0xBC, 0x69, 0xC3, 0x16, 0xEF, 0x3A, 0x90, 0x45,
    0x11, 0xC4, 0x6E, 0xBB, 0xC6, 0x13, 0xB9, 0x6C, 0x38, 0xED, 0x47, 0x92, 0xBD, 0x68, 0xC2, 0x17, 0x43, 0x96, 0x3C, 0xE9, 0x94, 0x41,
    0xEB, 0x3E, 0x6A, 0xBF, 0x15, 0xC0, 0x4B, 0x9E, 0x34, 0xE1, 0xB5, 0x60, 0xCA, 0x1F, 0x62, 0xB7, 0x1D, 0xC8, 0x9C, 0x49, 0xE3, 0x36,
    0x19, 0xCC, 0x66, 0xB3, 0xE7, 0x32, 0x98, 0x4D, 0x30, 0xE5, 0x4F, 0x9A, 0xCE, 0x1B, 0xB1, 0x64, 0x72, 0xA7, 0x0D, 0xD8, 0x8C, 0x59,
    0xF3, 0x26, 0x5B, 0x8E, 0x24, 0xF1, 0xA5, 0x70, 0xDA, 0x0F, 0x20, 0xF5, 0x5F, 0x8A, 0xDE, 0x0B, 0xA1, 0x74, 0x09, 0xDC, 0x76, 0xA3,
    0xF7, 0x22, 0x88, 0x5D, 0xD6, 0x03, 0xA9, 0x7C, 0x28, 0xFD, 0x57, 0x82, 0xFF, 0x2A, 0x80, 0x55, 0x01, 0xD4, 0x7E, 0xAB, 0x84, 0x51,
    0xFB, 0x2E, 0x7A, 0xAF, 0x05, 0xD0, 0xAD, 0x78, 0xD2, 0x07, 0x53, 0x86, 0x2C, 0xF9,
};

// Calculate CRC8
static uint8_t vscope_crc8(const uint8_t* data, uint16_t len) {
    uint8_t crc = 0;
    for (uint16_t i = 0; i < len; i += 1U) {
        crc = crc8_lut[crc ^ data[i]];
    }
    return crc;
}

// Read 16-bit unsigned integer
static uint16_t vscope_read_u16(const uint8_t* data) {
    uint16_t value = 0U;
    memcpy(&value, data, sizeof(value));
    return value;
}

// Read 32-bit unsigned integer
static uint32_t vscope_read_u32(const uint8_t* data) {
    uint32_t value = 0U;
    memcpy(&value, data, sizeof(value));
    return value;
}

// Read 32-bit float
static float vscope_read_f32(const uint8_t* data) {
    float value = 0.0f;
    memcpy(&value, data, sizeof(value));
    return value;
}

// Write 16-bit unsigned integer
static void vscope_write_u16(uint8_t* data, uint16_t value) {
    memcpy(data, &value, sizeof(value));
}

// Write 32-bit unsigned integer
static void vscope_write_u32(uint8_t* data, uint32_t value) {
    memcpy(data, &value, sizeof(value));
}

// Write 32-bit float
static void vscope_write_f32(uint8_t* data, float value) {
    memcpy(data, &value, sizeof(value));
}

// Write fixed-length string
static void vscope_write_str_fixed(uint8_t* dest, const char* src, size_t len) {
    memset(dest, 0, len);
    if (src == NULL) {
        return;
    }
    strncpy((char*)dest, src, len);
}

// Minimum of two 16-bit unsigned integers
static uint16_t vscope_min_u16(uint16_t a, uint16_t b) {
    return (a < b) ? a : b;
}

//*********************************************************
// Logical Functions
//*********************************************************

// Capture snapshot metadata
static void vscope_capture_snapshot_meta(void) {
    snapshot_meta.divider = vscope_divider;
    snapshot_meta.pre_trig = vscope_pre_trig;
    for (uint8_t i = 0U; i < VSCOPE_NUM_CHANNELS; i += 1U) {
        snapshot_meta.channel_map[i] = channel_map[i];
    }
    snapshot_meta.trigger_threshold = vscope_trigger_threshold;
    snapshot_meta.trigger_channel = vscope_trigger_channel;
    snapshot_meta.trigger_mode = (uint8_t)vscope_trigger_mode;

    for (uint8_t i = 0U; i < rt_count; i += 1U) {
        snapshot_rt_values[i] = *(rt_values[i]);
    }
}

// Reset RX state
static void vscope_reset_rx(void) {
    rx_state = VS_RX_IDLE;
    rx_expected_len = 0U;
    rx_index = 0U;
}

// Send frame
static void vscope_send_frame(uint8_t type, const uint8_t* payload, uint8_t payload_len) {
    if (payload_len > VSCOPE_MAX_PAYLOAD) {
        return;
    }

    uint8_t frame[VSCOPE_MAX_PAYLOAD + 4];
    uint8_t len_field = (uint8_t)(payload_len + 2U);
    uint16_t offset = 0U;

    frame[offset++] = VSCOPE_SYNC_BYTE;
    frame[offset++] = len_field;
    frame[offset++] = type;

    if (payload_len > 0U) {
        memcpy(&frame[offset], payload, payload_len);
        offset = (uint16_t)(offset + payload_len);
    }

    frame[offset++] = vscope_crc8(&frame[2], (uint16_t)(payload_len + 1U));

    vscopeTxBytes(frame, offset);
}

// Send error
static void vscope_send_error(uint8_t error_code) {
    vscope_send_frame(VSCOPE_MSG_ERROR, &error_code, 1U);
}

// Send payload
static void vscope_send_payload(uint8_t type, const uint8_t* data, uint16_t data_len) {
    if (data_len > VSCOPE_MAX_PAYLOAD) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }
    vscope_send_frame(type, data, data_len);
}

//*********************************************************
// Message Handlers
//*********************************************************

// INFO

static void vscope_handle_get_info(void) {
    uint8_t data[10 + VSCOPE_NAME_LEN];
    uint16_t offset = 0U;

    data[offset++] = (uint8_t)VSCOPE_NUM_CHANNELS;
    vscope_write_u16(&data[offset], (uint16_t)VSCOPE_BUFFER_SIZE);
    offset = (uint16_t)(offset + 2U);
    vscope_write_u16(&data[offset], vscope_isr_khz);
    offset = (uint16_t)(offset + 2U);
    data[offset++] = var_count;
    data[offset++] = rt_count;
    data[offset++] = (uint8_t)VSCOPE_RT_BUFFER_LEN;
    data[offset++] = (uint8_t)VSCOPE_NAME_LEN;
    data[offset++] = vscope_endianness;
    vscope_write_str_fixed(&data[offset], vscope_device_name, VSCOPE_NAME_LEN);

    vscope_send_payload(VSCOPE_MSG_GET_INFO, data, sizeof(data));
}

// TIMING

static void vscope_send_timing(uint8_t type) {
    uint8_t data[8];
    vscope_write_u32(&data[0], vscope_divider);
    vscope_write_u32(&data[4], vscope_pre_trig);
    vscope_send_payload(type, data, sizeof(data));
}

static void vscope_handle_get_timing(void) {
    vscope_send_timing(VSCOPE_MSG_GET_TIMING);
}

static void vscope_handle_set_timing(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 8U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint32_t divider = vscope_read_u32(&payload[0]);
    uint32_t pre_trig = vscope_read_u32(&payload[4]);

    if (divider == 0U || pre_trig > (uint32_t)VSCOPE_BUFFER_SIZE) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    if (vscope_state != VSCOPE_HALTED) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    vscope_divider = divider;
    vscope_pre_trig = pre_trig;
    vscope_acq_time = (uint32_t)VSCOPE_BUFFER_SIZE - vscope_pre_trig;
    vscope_send_timing(VSCOPE_MSG_SET_TIMING);
}

// STATE

static void vscope_send_state(uint8_t type) {
    uint8_t data[1];
    data[0] = (uint8_t)vscope_state;
    vscope_send_payload(type, data, sizeof(data));
}

static void vscope_handle_get_state(void) {
    vscope_send_state(VSCOPE_MSG_GET_STATE);
}

static void vscope_handle_set_state(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 1U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t requested = payload[0];
    if (requested > VSCOPE_ACQUIRING) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    vscope_request = (VscopeState)requested;
    vscope_send_state(VSCOPE_MSG_SET_STATE);
}

// TRIGGER

static void vscope_handle_trigger(void) {
    vscopeTrigger();
    vscope_send_payload(VSCOPE_MSG_TRIGGER, NULL, 0U);
}

// FRAME

static void vscope_handle_get_frame(void) {
    uint8_t data[VSCOPE_NUM_CHANNELS * 4];
    uint16_t offset = 0U;

    for (uint8_t i = 0U; i < VSCOPE_NUM_CHANNELS; i += 1U) {
        vscope_write_f32(&data[offset], *(vscope_frame[i]));
        offset = (uint16_t)(offset + 4U);
    }

    vscope_send_payload(VSCOPE_MSG_GET_FRAME, data, sizeof(data));
}

// SNAPSHOT

static void vscope_handle_get_snapshot_header(void) {
    if (!snapshot_valid) {
        vscope_send_error(VSCOPE_ERR_NOT_READY);
        return;
    }

    uint8_t data[VSCOPE_MAX_PAYLOAD];
    uint16_t offset = 0U;

    for (uint8_t i = 0U; i < VSCOPE_NUM_CHANNELS; i += 1U) {
        data[offset++] = snapshot_meta.channel_map[i];
    }

    vscope_write_u32(&data[offset], snapshot_meta.divider);
    offset = (uint16_t)(offset + 4U);
    vscope_write_u32(&data[offset], snapshot_meta.pre_trig);
    offset = (uint16_t)(offset + 4U);
    vscope_write_f32(&data[offset], snapshot_meta.trigger_threshold);
    offset = (uint16_t)(offset + 4U);
    data[offset++] = snapshot_meta.trigger_channel;
    data[offset++] = snapshot_meta.trigger_mode;

    for (uint8_t i = 0U; i < rt_count; i += 1U) {
        vscope_write_f32(&data[offset], snapshot_rt_values[i]);
        offset = (uint16_t)(offset + 4U);
    }

    vscope_send_payload(VSCOPE_MSG_GET_SNAPSHOT_HEADER, data, offset);
}

static void vscope_handle_get_snapshot_data(const uint8_t* payload, uint16_t payload_len) {
    if (!snapshot_valid) {
        vscope_send_error(VSCOPE_ERR_NOT_READY);
        return;
    }

    if (payload_len != 3U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint16_t start_sample = vscope_read_u16(payload);
    uint8_t requested_count = payload[2];

    if (start_sample >= (uint16_t)VSCOPE_BUFFER_SIZE || requested_count == 0U) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    uint16_t end_sample = (uint16_t)(start_sample + (uint16_t)requested_count);
    if (end_sample > (uint16_t)VSCOPE_BUFFER_SIZE) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    uint16_t max_samples = (uint16_t)(VSCOPE_MAX_PAYLOAD / (VSCOPE_NUM_CHANNELS * 4U));
    if (requested_count > max_samples) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t data[VSCOPE_MAX_PAYLOAD];
    uint16_t offset = 0U;

    uint16_t requested_count_u16 = (uint16_t)requested_count;
    uint16_t sample_index = (uint16_t)((vscope_first_element + start_sample) % (uint32_t)VSCOPE_BUFFER_SIZE);
    uint16_t max_contiguous = (uint16_t)(VSCOPE_BUFFER_SIZE - sample_index);
    uint16_t first_samples = (requested_count_u16 <= max_contiguous) ? requested_count_u16 : max_contiguous;
    uint16_t first_bytes = (uint16_t)(first_samples * (uint16_t)VSCOPE_NUM_CHANNELS * 4U);

    memcpy(&data[offset], &vscope_buffer[sample_index][0], first_bytes);
    offset = (uint16_t)(offset + first_bytes);

    if (first_samples < requested_count_u16) {
        uint16_t remaining = (uint16_t)(requested_count_u16 - first_samples);
        uint16_t second_bytes = (uint16_t)(remaining * (uint16_t)VSCOPE_NUM_CHANNELS * 4U);
        memcpy(&data[offset], &vscope_buffer[0][0], second_bytes);
        offset = (uint16_t)(offset + second_bytes);
    }

    vscope_send_payload(VSCOPE_MSG_GET_SNAPSHOT_DATA, data, offset);
}

// VAR LIST

static void vscope_handle_get_var_list(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 2U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t start_idx = payload[0];
    uint8_t requested_count = payload[1];

    if (start_idx > var_count) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    uint16_t max_entries = (uint16_t)((VSCOPE_MAX_PAYLOAD - 3U) / (uint16_t)VSCOPE_NAME_LEN);
    uint16_t available = (uint16_t)(var_count - start_idx);
    uint16_t desired = (uint16_t)requested_count;
    uint16_t count = vscope_min_u16(desired, vscope_min_u16(available, max_entries));

    uint8_t data[VSCOPE_MAX_PAYLOAD];
    uint16_t offset = 0U;
    data[offset++] = var_count;
    data[offset++] = start_idx;
    data[offset++] = (uint8_t)count;

    for (uint16_t i = 0U; i < count; i += 1U) {
        uint8_t id = (uint8_t)(start_idx + i);
        vscope_write_str_fixed(&data[offset], var_catalog[id].name, VSCOPE_NAME_LEN);
        offset = (uint16_t)(offset + VSCOPE_NAME_LEN);
    }

    vscope_send_payload(VSCOPE_MSG_GET_VAR_LIST, data, offset);
}

// CHANNEL MAP

static void vscope_handle_get_channel_map(void) {
    vscope_send_payload(VSCOPE_MSG_GET_CHANNEL_MAP, channel_map, (uint16_t)VSCOPE_NUM_CHANNELS);
}

static void vscope_handle_set_channel_map(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 2U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t channel_idx = payload[0];
    uint8_t catalog_idx = payload[1];

    if (channel_idx >= VSCOPE_NUM_CHANNELS || catalog_idx >= var_count) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    channel_map[channel_idx] = catalog_idx;
    vscope_frame[channel_idx] = var_catalog[catalog_idx].ptr;

    uint8_t data[2] = { channel_idx, catalog_idx };
    vscope_send_payload(VSCOPE_MSG_SET_CHANNEL_MAP, data, sizeof(data));
}

// RT LABELS

static void vscope_handle_get_rt_labels(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 2U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t start_idx = payload[0];
    uint8_t requested_count = payload[1];

    if (start_idx > rt_count) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    uint16_t entry_size = (uint16_t)VSCOPE_NAME_LEN;
    uint16_t max_entries = (uint16_t)((VSCOPE_MAX_PAYLOAD - 3U) / entry_size);
    uint16_t available = (uint16_t)(rt_count - start_idx);
    uint16_t desired = (uint16_t)requested_count;
    uint16_t count = vscope_min_u16(desired, vscope_min_u16(available, max_entries));

    uint8_t data[VSCOPE_MAX_PAYLOAD];
    uint16_t offset = 0U;
    data[offset++] = rt_count;
    data[offset++] = start_idx;
    data[offset++] = (uint8_t)count;

    for (uint16_t i = 0U; i < count; i += 1U) {
        uint8_t id = (uint8_t)(start_idx + i);
        vscope_write_str_fixed(&data[offset], rt_names[id], VSCOPE_NAME_LEN);
        offset = (uint16_t)(offset + VSCOPE_NAME_LEN);
    }

    vscope_send_payload(VSCOPE_MSG_GET_RT_LABELS, data, offset);
}

// RT BUFFER

static void vscope_send_rt_buffer_value(uint8_t type, uint8_t idx) {
    float value = *(rt_values[idx]);
    vscope_send_payload(type, (const uint8_t*)&value, sizeof(value));
}

static void vscope_handle_get_rt_buffer(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 1U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t idx = payload[0];
    if (idx >= rt_count) {
        vscope_send_error(VSCOPE_ERR_RANGE);
        return;
    }

    vscope_send_rt_buffer_value(VSCOPE_MSG_GET_RT_BUFFER, idx);
}

static void vscope_handle_set_rt_buffer(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 5U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    uint8_t idx = payload[0];
    if (idx >= rt_count) {
        vscope_send_error(VSCOPE_ERR_RANGE);
        return;
    }

    float value = vscope_read_f32(&payload[1]);
    *(rt_values[idx]) = value;
    vscope_send_rt_buffer_value(VSCOPE_MSG_SET_RT_BUFFER, idx);
}

// TRIGGER

static void vscope_send_trigger(uint8_t type) {
    uint8_t data[6];
    vscope_write_f32(&data[0], vscope_trigger_threshold);
    data[4] = vscope_trigger_channel;
    data[5] = (uint8_t)vscope_trigger_mode;
    vscope_send_payload(type, data, sizeof(data));
}

static void vscope_handle_get_trigger(void) {
    vscope_send_trigger(VSCOPE_MSG_GET_TRIGGER);
}

static void vscope_handle_set_trigger(const uint8_t* payload, uint16_t payload_len) {
    if (payload_len != 6U) {
        vscope_send_error(VSCOPE_ERR_BAD_LEN);
        return;
    }

    float threshold = vscope_read_f32(&payload[0]);
    uint8_t channel = payload[4];
    uint8_t mode = payload[5];

    if (channel >= VSCOPE_NUM_CHANNELS || mode > (uint8_t)VSCOPE_TRG_BOTH) {
        vscope_send_error(VSCOPE_ERR_BAD_PARAM);
        return;
    }

    vscope_trigger_threshold = threshold;
    vscope_trigger_channel = channel;
    vscope_trigger_mode = (VscopeTriggerMode)mode;
    trigger_invalid = true;
    vscope_send_trigger(VSCOPE_MSG_SET_TRIGGER);
}

// MESSAGE HANDLER

static void vscope_handle_frame(uint8_t type, const uint8_t* payload, uint16_t payload_len) {
    // When misconfigured, only allow diagnostic queries
    if (vscope_state == VSCOPE_MISCONFIGURED) {
        if (type != VSCOPE_MSG_GET_INFO && type != VSCOPE_MSG_GET_STATE && type != VSCOPE_MSG_GET_VAR_LIST) {
            vscope_send_error(VSCOPE_ERR_NOT_READY);
            return;
        }
    }

    switch (type) {
        case VSCOPE_MSG_GET_INFO:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_info();
            }
            break;
        case VSCOPE_MSG_GET_TIMING:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_timing();
            }
            break;
        case VSCOPE_MSG_SET_TIMING:
            vscope_handle_set_timing(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_STATE:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_state();
            }
            break;
        case VSCOPE_MSG_SET_STATE:
            vscope_handle_set_state(payload, payload_len);
            break;
        case VSCOPE_MSG_TRIGGER:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_trigger();
            }
            break;
        case VSCOPE_MSG_GET_FRAME:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_frame();
            }
            break;
        case VSCOPE_MSG_GET_SNAPSHOT_HEADER:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_snapshot_header();
            }
            break;
        case VSCOPE_MSG_GET_SNAPSHOT_DATA:
            vscope_handle_get_snapshot_data(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_VAR_LIST:
            vscope_handle_get_var_list(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_CHANNEL_MAP:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_channel_map();
            }
            break;
        case VSCOPE_MSG_SET_CHANNEL_MAP:
            vscope_handle_set_channel_map(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_RT_LABELS:
            vscope_handle_get_rt_labels(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_RT_BUFFER:
            vscope_handle_get_rt_buffer(payload, payload_len);
            break;
        case VSCOPE_MSG_SET_RT_BUFFER:
            vscope_handle_set_rt_buffer(payload, payload_len);
            break;
        case VSCOPE_MSG_GET_TRIGGER:
            if (payload_len != 0U) {
                vscope_send_error(VSCOPE_ERR_BAD_LEN);
            } else {
                vscope_handle_get_trigger();
            }
            break;
        case VSCOPE_MSG_SET_TRIGGER:
            vscope_handle_set_trigger(payload, payload_len);
            break;
        default:
            vscope_send_error(VSCOPE_ERR_BAD_PARAM);
            break;
    }
}

//*********************************************************
// Public Functions
//*********************************************************

void vscopeRegisterVar(const char* name, volatile float* ptr) {
    if (registration_locked || var_count >= VSCOPE_MAX_VARIABLES || ptr == NULL) {
        return;
    }

    memset(var_catalog[var_count].name, 0, VSCOPE_NAME_LEN);
    if (name != NULL) {
        strncpy(var_catalog[var_count].name, name, VSCOPE_NAME_LEN);
    }
    var_catalog[var_count].ptr = ptr;
    var_count += 1U;
}

void vscopeRegisterRtBuffer(const char* name, volatile float* ptr) {
    if (registration_locked || rt_count >= VSCOPE_RT_BUFFER_LEN || ptr == NULL) {
        return;
    }

    memset(rt_names[rt_count], 0, VSCOPE_NAME_LEN);
    if (name != NULL) {
        strncpy(rt_names[rt_count], name, VSCOPE_NAME_LEN);
    }
    rt_values[rt_count] = ptr;
    rt_count += 1U;
}

void vscopeRxHandler(const uint8_t* data, size_t len, uint64_t now_us) {
    if (data == NULL || len == 0U) {
        return;
    }

    if (rx_state != VS_RX_IDLE && (now_us - rx_last_us) > (uint64_t)VSCOPE_FRAME_TIMEOUT_US) {
        vscope_reset_rx();
    }

    for (size_t i = 0U; i < len; i += 1U) {
        uint8_t byte = data[i];

        switch (rx_state) {
            case VS_RX_IDLE:
                if (byte == VSCOPE_SYNC_BYTE) {
                    rx_state = VS_RX_LEN;
                    rx_last_us = now_us;
                }
                break;
            case VS_RX_LEN:
                rx_expected_len = byte;
                if (rx_expected_len < 2U || rx_expected_len > (uint16_t)(VSCOPE_MAX_PAYLOAD + 2U)) {
                    vscope_reset_rx();
                } else {
                    rx_index = 0U;
                    rx_state = VS_RX_DATA;
                }
                rx_last_us = now_us;
                break;
            case VS_RX_DATA:
                rx_buf[rx_index++] = byte;
                rx_last_us = now_us;
                if (rx_index >= rx_expected_len) {
                    uint8_t crc = rx_buf[rx_expected_len - 1U];
                    uint8_t calc = vscope_crc8(rx_buf, (uint16_t)(rx_expected_len - 1U));
                    if (crc == calc) {
                        uint8_t type = rx_buf[0];
                        const uint8_t* payload = &rx_buf[1];
                        uint16_t payload_len = (uint16_t)(rx_expected_len - 2U);
                        vscope_handle_frame(type, payload, payload_len);
                    }
                    vscope_reset_rx();
                }
                break;
            default:
                vscope_reset_rx();
                break;
        }
    }
}

void vscopeInit(const char* device_name, uint16_t isr_khz, uint8_t endianness) {
    // State + configuration
    vscope_state = VSCOPE_HALTED;
    vscope_request = VSCOPE_HALTED;
    vscope_isr_khz = isr_khz;

    memset(vscope_device_name, 0, sizeof(vscope_device_name));
    vscope_write_str_fixed((uint8_t*)vscope_device_name, device_name, VSCOPE_NAME_LEN);

    vscope_endianness = VSCOPE_ENDIAN_LITTLE;
    if (endianness <= VSCOPE_ENDIAN_BIG) {
        vscope_endianness = endianness;
    }

    // Timing + acquisition counters
    vscope_divider = 1U;
    vscope_pre_trig = 0U;
    vscope_acq_time = (uint32_t)VSCOPE_BUFFER_SIZE - vscope_pre_trig;
    vscope_index = 0U;
    vscope_first_element = 0U;

    // Trigger configuration
    vscope_trigger_threshold = 0.0f;
    vscope_trigger_channel = 0U;
    vscope_trigger_mode = VSCOPE_TRG_DISABLED;
    trigger_invalid = true;

    // Variable registry + channel map
    memset(vscope_frame, 0, sizeof(vscope_frame));
    memset(channel_map, 0, sizeof(channel_map));
    registration_locked = true;

    if (var_count < VSCOPE_NUM_CHANNELS) {
        vscope_state = VSCOPE_MISCONFIGURED;
    } else {
        for (uint8_t i = 0U; i < VSCOPE_NUM_CHANNELS; i += 1U) {
            channel_map[i] = i;
            vscope_frame[i] = var_catalog[i].ptr;
        }
    }

    // Frame + capture buffers
    memset(vscope_buffer, 0, sizeof(vscope_buffer));

    // Snapshot data
    snapshot_valid = false;
}

static void vscope_save_frame(void) {
    for (uint8_t i = 0U; i < VSCOPE_NUM_CHANNELS; i += 1U) {
        vscope_buffer[vscope_index][i] = *(vscope_frame[i]);
    }

    vscope_index += 1U;
    if (vscope_index >= (uint32_t)VSCOPE_BUFFER_SIZE) {
        vscope_index = 0U;
    }
}

static void vscope_check_trigger(void) {
    static float last_delta = 0.0f;

    float current_delta = *(vscope_frame[vscope_trigger_channel]) - vscope_trigger_threshold;

    if (trigger_invalid) {
        last_delta = current_delta;
        trigger_invalid = false;
        return;
    }

    if (vscope_trigger_mode == VSCOPE_TRG_DISABLED) {
        last_delta = current_delta;
        return;
    }

    if ((current_delta * last_delta) < 0.0f) {
        if (current_delta > 0.0f) {
            if (vscope_trigger_mode != VSCOPE_TRG_FALLING) {
                vscopeTrigger();
            }
        } else {
            if (vscope_trigger_mode != VSCOPE_TRG_RISING) {
                vscopeTrigger();
            }
        }
    }

    last_delta = current_delta;
}

void vscopeAcquire(void) {
    static uint32_t divider_ticks = 0U;
    static uint16_t run_index = 0U;

    if (vscope_state == VSCOPE_MISCONFIGURED) {
        return;
    }

    divider_ticks += 1U;
    if (divider_ticks < vscope_divider) {
        return;
    }
    divider_ticks = 0U;

    vscope_check_trigger();

    switch (vscope_state) {
        case VSCOPE_HALTED:
            vscope_index = 0U;
            if (vscope_request == VSCOPE_RUNNING) {
                vscope_state = VSCOPE_RUNNING;
                snapshot_valid = false;
            }
            break;
        case VSCOPE_RUNNING:
            if (vscope_request == VSCOPE_HALTED) {
                vscope_state = VSCOPE_HALTED;
            }
            if (vscope_request == VSCOPE_ACQUIRING) {
                vscope_capture_snapshot_meta();
                if (vscope_acq_time == 0U) {
                    vscope_state = VSCOPE_HALTED;
                    vscope_first_element = vscope_index;
                    snapshot_valid = true;
                } else {
                    vscope_state = VSCOPE_ACQUIRING;
                    run_index = 1U;
                }
            }
            vscope_save_frame();
            break;
        case VSCOPE_ACQUIRING:
            if (run_index == vscope_acq_time) {
                vscope_state = VSCOPE_HALTED;
                vscope_first_element = vscope_index;
                snapshot_valid = true;
            } else {
                run_index += 1U;
                vscope_save_frame();
            }
            break;
        default:
            break;
    }
}

void vscopeTrigger(void) {
    if (vscope_state == VSCOPE_RUNNING) {
        vscope_request = VSCOPE_ACQUIRING;
    }
}
