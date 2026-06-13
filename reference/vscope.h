/**
 * @file vscope.h
 * @brief VScope - Virtual oscilloscope for embedded microcontrollers.
 *
 * Provides data acquisition, real-time buffering, and snapshot storage
 * for debugging and visualization of embedded system variables.
 *
 * @copyright Copyright (c) 2026 Tom Ford
 */

#ifndef VSCOPE_H
#define VSCOPE_H

#include <stddef.h>
#include <stdint.h>

// Endianness values for GET_INFO and host decoding
#define VSCOPE_ENDIAN_LITTLE 0U
#define VSCOPE_ENDIAN_BIG 1U

/**
 * @brief User-provided serial transmit function.
 *
 * Must be implemented by the application to send data over the transport
 * layer (SPI, UART, USB CDC, etc.).
 *
 * @param data Pointer to the data buffer to transmit.
 * @param len  Number of bytes to transmit (expects up to 256).
 */
void vscopeTxBytes(const uint8_t* data, size_t len);

/**
 * @brief Register a variable for data acquisition.
 *
 * Registered variables can be mapped to acquisition channels and sampled
 * during high-speed data capture.
 *
 * @param name Variable name (max 16 chars).
 * @param ptr  Pointer to the float variable to sample.
 *
 * @note Up to VSCOPE_MAX_VARIABLES can be registered.
 */
void vscopeRegisterVar(const char* name, volatile float* ptr);

/**
 * @brief Register a real-time buffer variable.
 *
 * RT buffer variables are sampled at a lower rate and provide live
 * visibility into control parameters and system state.
 *
 * @param name Variable name (max 16 chars).
 * @param ptr  Pointer to the float variable to sample.
 *
 * @note Up to VSCOPE_RT_BUFFER_LEN entries can be registered.
 */
void vscopeRegisterRtBuffer(const char* name, volatile float* ptr);

/**
 * @brief Feed raw serial bytes into the protocol parser.
 *
 * Call this from your transport layer RX handler to process incoming commands.
 * The parser handles CRSF-style framing with timeout detection.
 *
 * @param data   Pointer to received byte buffer.
 * @param len    Number of bytes received.
 * @param now_us Current timestamp in microseconds (for frame timeout).
 */
void vscopeRxHandler(const uint8_t* data, size_t len, uint64_t now_us);

/**
 * @brief Initialize the VScope device.
 *
 * Must be called once at startup after registering variables or
 * calling other VScope functions.
 *
 * @param device_name Device identifier string (max 16 chars).
 * @param isr_khz     Acquisition ISR frequency in kHz.
 * @param endianness  Byte order for multi-byte fields (VSCOPE_ENDIAN_*).
 */
void vscopeInit(const char* device_name, uint16_t isr_khz, uint8_t endianness);

/**
 * @brief High-speed ISR acquisition function.
 *
 * Call this from a timer ISR at the configured sample rate (isr_khz).
 * Samples all mapped channels into the acquisition buffer when running.
 *
 * @note Must be called from ISR context at consistent intervals.
 */
void vscopeAcquire(void);

/**
 * @brief Manually trigger data acquisition.
 *
 * Forces an immediate trigger event, useful for software-initiated captures.
 */
void vscopeTrigger(void);

#endif // VSCOPE_H
