#!/usr/bin/env ts-node
/**
 * 为老的 instruction 事件补充缺失的数据
 */

import { MongoClient } from 'mongodb';

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI environment variable is required');
  process.exit(1);
}
const MONGODB_DB = process.env.MONGODB_DB || 'gitlab-copilot';

async function patchOldEvents() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('已连接到 MongoDB');

    const db = client.db(MONGODB_DB);
    const collection = db.collection('events');

    // 找到所有 responseType: 'instruction' 但状态还是 received 的事件
    const oldInstructions = await collection.find({
      responseType: 'instruction',
      status: 'received'
    }).toArray();

    console.log(`\n找到 ${oldInstructions.length} 条需要修复的指令事件`);

    if (oldInstructions.length === 0) {
      console.log('没有需要修复的数据');
      return;
    }

    // 为这些事件设置合理的默认值
    let updatedCount = 0;

    for (const event of oldInstructions) {
      // 假设这些老事件都已经成功处理了（因为有 instructionText 说明触发了 AI）
      // 设置一个合理的默认执行时间（5秒）
      const updates: any = {
        status: 'processed',
        processedAt: new Date(event.receivedAt.getTime() + 5000), // 假设5秒后处理完成
        executionTimeMs: 5000
      };

      await collection.updateOne(
        { _id: event._id },
        { $set: updates }
      );

      updatedCount++;
    }

    console.log(`已更新 ${updatedCount} 条记录`);

    // 重新统计
    console.log('\n=== 修复后的统计 ===');

    const stats = await collection.aggregate([
      {
        $match: { responseType: 'instruction' }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgDuration: { $avg: '$executionTimeMs' }
        }
      }
    ]).toArray();

    console.log('\nAI 指令事件统计:');
    stats.forEach((s: any) => {
      console.log(`  status: ${s._id}, count: ${s.count}, avgDuration: ${Math.round(s.avgDuration || 0)}ms`);
    });

    // 统计成功率
    const total = await collection.countDocuments({ responseType: 'instruction' });
    const successful = await collection.countDocuments({
      responseType: 'instruction',
      status: 'processed'
    });
    const failed = await collection.countDocuments({
      responseType: 'instruction',
      status: 'error'
    });

    console.log(`\n总计: ${total} 条指令`);
    console.log(`成功: ${successful} 条 (${((successful / total) * 100).toFixed(1)}%)`);
    console.log(`失败: ${failed} 条 (${((failed / total) * 100).toFixed(1)}%)`);

    console.log('\n✅ 补丁完成！');

  } catch (error) {
    console.error('补丁失败:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

patchOldEvents();
