#!/usr/bin/env ts-node
/**
 * 修复 events 表中的数据问题：
 * 1. 修复 aiProvider 字段（从 instructionText 中提取）
 * 2. 刷新统计相关数据（executionTimeMs, status）
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}
const MONGODB_DB = process.env.MONGODB_DB || 'gitlab-copilot';

interface EventRecord {
  _id: unknown;
  instructionText?: string;
  aiProvider?: string;
  status?: string;
  receivedAt?: Date;
  processedAt?: Date;
  executionTimeMs?: number;
}

async function fixEventData() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('已连接到 MongoDB');

    const db = client.db(MONGODB_DB);
    const collection = db.collection<EventRecord>('events');

    // 1. 修复 aiProvider 字段
    console.log('\n=== 修复 aiProvider 字段 ===');

    // 查找所有 aiProvider 为 claude 但 instructionText 包含 @codex 的记录
    const codexEvents = await collection.find({
      aiProvider: 'claude',
      instructionText: { $regex: /@codex/i }
    }).toArray();

    console.log(`找到 ${codexEvents.length} 条 @codex 指令被错误标记为 claude 的记录`);

    if (codexEvents.length > 0) {
      const result = await collection.updateMany(
        {
          aiProvider: 'claude',
          instructionText: { $regex: /@codex/i }
        },
        {
          $set: { aiProvider: 'codex' }
        }
      );
      console.log(`已更新 ${result.modifiedCount} 条记录的 aiProvider 为 codex`);
    }

    // 2. 检查并修复缺少 aiProvider 的记录
    console.log('\n=== 检查缺少 aiProvider 的记录 ===');
    const noProviderEvents = await collection.find({
      $or: [
        { aiProvider: { $exists: false } },
        { aiProvider: null as any }
      ],
      instructionText: { $exists: true, $ne: '' }
    }).toArray();

    console.log(`找到 ${noProviderEvents.length} 条缺少 aiProvider 的记录`);

    for (const event of noProviderEvents) {
      const provider = event.instructionText?.match(/@codex/i) ? 'codex' : 'claude';
      await collection.updateOne(
        { _id: event._id },
        { $set: { aiProvider: provider } }
      );
    }

    if (noProviderEvents.length > 0) {
      console.log(`已修复 ${noProviderEvents.length} 条记录的 aiProvider`);
    }

    // 3. 计算并填充 executionTimeMs
    console.log('\n=== 修复 executionTimeMs 字段 ===');
    const eventsWithoutDuration = await collection.find({
      $or: [
        { executionTimeMs: { $exists: false } },
        { executionTimeMs: null as any }
      ],
      receivedAt: { $exists: true },
      processedAt: { $exists: true },
      status: { $in: ['processed', 'error'] }
    }).toArray();

    console.log(`找到 ${eventsWithoutDuration.length} 条缺少 executionTimeMs 的已处理记录`);

    for (const event of eventsWithoutDuration) {
      if (event.receivedAt && event.processedAt) {
        const duration = new Date(event.processedAt).getTime() - new Date(event.receivedAt).getTime();
        await collection.updateOne(
          { _id: event._id },
          { $set: { executionTimeMs: duration } }
        );
      }
    }

    if (eventsWithoutDuration.length > 0) {
      console.log(`已计算并填充 ${eventsWithoutDuration.length} 条记录的 executionTimeMs`);
    }

    // 4. 修复没有 responseType 但有 instructionText 的事件（这些是 AI 响应）
    console.log('\n=== 修复缺少 responseType 的 AI 响应记录 ===');

    // AI 响应的特征：有 instructionText 但 responseType 为空
    const aiResponsesWithoutType = await collection.find({
      status: 'received',
      instructionText: { $exists: true, $ne: '' },
      $and: [
        {
          $or: [
            { instructionText: { $ne: null as any } }
          ]
        },
        {
          $or: [
            { responseType: { $exists: false } },
            { responseType: null as any }
          ]
        }
      ]
    }).toArray();

    console.log(`找到 ${aiResponsesWithoutType.length} 条 AI 响应记录缺少 responseType`);

    // 检测是否是进度更新（通常包含特定格式）
    for (const event of aiResponsesWithoutType) {
      let responseType = 'final'; // 默认为最终响应
      let isProgressResponse = false;

      if (event.instructionText) {
        const text = event.instructionText;

        // 检测是否是进度响应
        if (text.includes('## Summary') || text.includes('## Changes Made')) {
          responseType = 'final';
        } else if (text.includes('正在') || text.includes('开始') || text.includes('处理')) {
          responseType = 'progress';
          isProgressResponse = true;
        }
      }

      await collection.updateOne(
        { _id: event._id },
        {
          $set: {
            responseType,
            isProgressResponse,
            status: 'processed' // AI 响应记录应该标记为已处理
          }
        }
      );
    }

    if (aiResponsesWithoutType.length > 0) {
      console.log(`已修复 ${aiResponsesWithoutType.length} 条 AI 响应记录的 responseType 和 status`);
    }

    // 5. 对于没有 instructionText 的 received 记录，这些是普通的 webhook 接收事件，保持 received 状态
    const normalWebhooks = await collection.countDocuments({
      status: 'received',
      $or: [
        { instructionText: { $exists: false } },
        { instructionText: null as any },
        { instructionText: '' }
      ]
    });

    console.log(`\n普通 webhook 事件（无 AI 指令）: ${normalWebhooks} 条，保持 received 状态`);

    // 6. 检查 received 状态的老数据，如果有 processedAt 但状态还是 received，更新为 processed
    console.log('\n=== 修复状态不一致的记录 ===');
    const inconsistentStatus = await collection.find({
      status: 'received',
      processedAt: { $exists: true, $ne: null as any }
    }).toArray();

    console.log(`找到 ${inconsistentStatus.length} 条状态不一致的记录（已处理但状态还是 received）`);

    if (inconsistentStatus.length > 0) {
      const result = await collection.updateMany(
        {
          status: 'received',
          processedAt: { $exists: true, $ne: null as any }
        },
        {
          $set: { status: 'processed' }
        }
      );
      console.log(`已更新 ${result.modifiedCount} 条记录的状态为 processed`);
    }

    // 7. 最终统计
    console.log('\n=== 修复后的数据统计 ===');

    const stats = await collection.aggregate([
      {
        $facet: {
          providerStats: [
            {
              $group: {
                _id: '$aiProvider',
                count: { $sum: 1 }
              }
            }
          ],
          statusStats: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 }
              }
            }
          ],
          durationStats: [
            {
              $match: {
                executionTimeMs: { $exists: true, $ne: null }
              }
            },
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                avgDuration: { $avg: '$executionTimeMs' },
                minDuration: { $min: '$executionTimeMs' },
                maxDuration: { $max: '$executionTimeMs' }
              }
            }
          ]
        }
      }
    ]).toArray();

    const result = stats[0];

    console.log('\nAI Provider 分布:');
    result.providerStats.forEach((item: any) => {
      console.log(`  ${item._id || 'null'}: ${item.count}`);
    });

    console.log('\n状态分布:');
    result.statusStats.forEach((item: any) => {
      console.log(`  ${item._id}: ${item.count}`);
    });

    if (result.durationStats.length > 0) {
      const durStats = result.durationStats[0];
      console.log('\n执行时间统计:');
      console.log(`  有执行时间的记录数: ${durStats.count}`);
      console.log(`  平均执行时间: ${Math.round(durStats.avgDuration)}ms`);
      console.log(`  最小执行时间: ${durStats.minDuration}ms`);
      console.log(`  最大执行时间: ${durStats.maxDuration}ms`);
    }

    console.log('\n✅ 数据修复完成！');

  } catch (error) {
    console.error('修复数据时出错:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

fixEventData();
