#!/usr/bin/env node

/**
 * 测试按GitLab配置统计的API端点
 *
 * 使用方法:
 * MONGODB_URI='mongodb://...' MONGODB_DB='gitlab-copilot' ENCRYPTION_KEY='test-key' LOG_LEVEL='error' node test-config-stats-api.js
 */

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const MONGODB_DB = process.env.MONGODB_DB || 'gitlab-copilot';

async function testConfigStats() {
  const client = new MongoClient(MONGODB_URI);

  try {
    await client.connect();
    console.log('✅ 已连接到MongoDB');

    const db = client.db(MONGODB_DB);

    // 1. 查找一个GitLab配置
    const config = await db.collection('gitlab_configs').findOne({ isActive: true });
    if (!config) {
      console.log('❌ 未找到活跃的GitLab配置');
      return;
    }

    const configId = config._id.toString();
    console.log(`\n📋 测试配置: ${config.name} (ID: ${configId})`);
    console.log(`   GitLab URL: ${config.gitlabUrl}`);

    // 2. 查询该配置的事件统计
    const eventsCount = await db.collection('events').countDocuments({
      gitlabConfigId: configId
    });
    console.log(`\n📊 该配置的事件数量: ${eventsCount}`);

    if (eventsCount === 0) {
      console.log('⚠️  该配置暂无事件数据，无法测试统计功能');

      // 显示所有有数据的配置
      const pipeline = [
        {
          $group: {
            _id: '$gitlabConfigId',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ];

      const configStats = await db.collection('events').aggregate(pipeline).toArray();

      if (configStats.length > 0) {
        console.log('\n有事件数据的配置列表:');
        for (const stat of configStats) {
          if (stat._id) {
            console.log(`  - 配置ID: ${stat._id}, 事件数: ${stat.count}`);
          }
        }
      }
      return;
    }

    // 3. 按上下文类型统计
    const contextPipeline = [
      {
        $match: {
          gitlabConfigId: configId,
          responseType: 'instruction',
          $or: [
            { isProgressResponse: { $ne: true } },
            { isProgressResponse: { $exists: false } }
          ]
        }
      },
      {
        $group: {
          _id: '$eventContext',
          count: { $sum: 1 }
        }
      }
    ];

    const contextStats = await db.collection('events').aggregate(contextPipeline).toArray();
    console.log('\n📈 按上下文类型统计:');
    for (const stat of contextStats) {
      const contextLabels = {
        'merge_request': 'Merge Request',
        'merge_request_comment': 'MR Comment',
        'issue': 'Issue',
        'issue_comment': 'Issue Comment'
      };
      const label = contextLabels[stat._id] || stat._id;
      console.log(`   ${label}: ${stat.count}`);
    }

    // 4. 按项目统计
    const projectPipeline = [
      {
        $match: {
          gitlabConfigId: configId,
          responseType: 'instruction',
          $or: [
            { isProgressResponse: { $ne: true } },
            { isProgressResponse: { $exists: false } }
          ]
        }
      },
      {
        $group: {
          _id: { projectId: '$projectId', projectName: '$projectName' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      },
      {
        $limit: 5
      }
    ];

    const projectStats = await db.collection('events').aggregate(projectPipeline).toArray();
    console.log('\n🏗️  Top 5 项目统计:');
    for (const stat of projectStats) {
      const projectName = stat._id.projectName || `Project ${stat._id.projectId}`;
      console.log(`   ${projectName}: ${stat.count}`);
    }

    // 5. 成功率统计
    const statusPipeline = [
      {
        $match: {
          gitlabConfigId: configId,
          responseType: 'instruction',
          $or: [
            { isProgressResponse: { $ne: true } },
            { isProgressResponse: { $exists: false } }
          ]
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ];

    const statusStats = await db.collection('events').aggregate(statusPipeline).toArray();
    const statusMap = {};
    let total = 0;
    for (const stat of statusStats) {
      statusMap[stat._id] = stat.count;
      total += stat.count;
    }

    const successCount = statusMap['processed'] || 0;
    const failedCount = statusMap['error'] || 0;
    const successRate = total > 0 ? Math.round((successCount / total) * 100) : 0;

    console.log('\n✅ 成功率统计:');
    console.log(`   成功: ${successCount}`);
    console.log(`   失败: ${failedCount}`);
    console.log(`   成功率: ${successRate}%`);

    // 6. API端点说明
    console.log('\n🔗 可用的API端点:');
    console.log(`   GET /api/usage-stats/by-config/${configId}`);
    console.log(`   GET /api/usage-stats/by-config/${configId}/webhooks`);
    console.log(`   GET /api/usage-stats/by-config/${configId}/comprehensive`);
    console.log('\n   查询参数:');
    console.log('   - period: day|week|month|year (默认: month)');
    console.log('   - startDate: ISO日期字符串');
    console.log('   - endDate: ISO日期字符串');

    console.log('\n✅ 测试完成!');

  } catch (error) {
    console.error('❌ 测试失败:', error.message);
    throw error;
  } finally {
    await client.close();
  }
}

testConfigStats().catch(err => {
  console.error('执行错误:', err);
  process.exit(1);
});
